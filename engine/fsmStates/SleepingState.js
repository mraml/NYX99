import { BaseState } from './BaseState.js';
import { Selector, Sequence, Condition, Action, Status } from '../BehaviorTreeCore.js';
import { GAME_BALANCE } from '../../data/balance.js';
import eventBus from '../../engine/eventBus.js';

const SLEEP_CONFIG = {
    BASE_REGEN: 5.0,
    DEEP_SLEEP_MULTIPLIER: 1.5,
    REM_THRESHOLD_TICKS: 10,
    WAKE_THRESHOLD: 99.5,
    NOISE_WAKE_THRESHOLD: 0.85,
    NIGHTMARE_STRESS_THRESHOLD: 60
};

// === 1. LEAF NODES ===

const Actions = {
    InitializeSleep: (agent) => {
        if (agent.stateContext.sleepDepthTicks !== undefined) return Status.SUCCESS;

        agent.stateContext.sleepDepthTicks = 0;
        agent.stateContext.initialFatigue = Math.max(0, 100 - (agent.energy || 0));
        
        // Calculate Efficiency based on bed quality (mocked here, could check Furniture)
        agent.stateContext.sleepEfficiency = 1.0; 
        
        // Circadian Rhythm Init
        if (!agent.circadianBias) {
            const p = agent.persona || {};
            agent.circadianBias = (p.conscientiousness || 0.5) > (p.openness || 0.5) ? 6 : 10;
        }

        return Status.SUCCESS;
    },

    RegenerateStats: (agent, { localEnv }) => {
        agent.stateContext.sleepDepthTicks++;
        
        // Quality Calc
        let quality = 1.0;
        if ((localEnv.noise ?? 0) > 0.4) quality -= 0.25;
        const isHomeless = !agent.homeLocationId || agent.locationId !== agent.homeLocationId;
        if (isHomeless) quality *= 0.8;

        // Regen
        const deepSleepBonus = agent.stateContext.sleepDepthTicks > SLEEP_CONFIG.REM_THRESHOLD_TICKS 
            ? SLEEP_CONFIG.DEEP_SLEEP_MULTIPLIER 
            : 1.0;

        const effectiveRegen = Math.max(0.1, SLEEP_CONFIG.BASE_REGEN * deepSleepBonus * quality);
        
        agent.energy = Math.min(100, (agent.energy ?? 0) + effectiveRegen);
        agent.stress = Math.max(0, (agent.stress ?? 0) - (2.0 * quality));
        agent.boredom = Math.max(0, (agent.boredom ?? 0) - (4 * quality));
        
        // Sickness recovery
        if (agent.status_effects?.some(e => e.type === 'SICK')) {
            // Logic to reduce sick duration could go here
        }

        return Status.SUCCESS;
    },

    DreamLogic: (agent, { worldState }) => {
        // Only dream in deep sleep
        if (agent.stateContext.sleepDepthTicks < SLEEP_CONFIG.REM_THRESHOLD_TICKS) return Status.SUCCESS;

        if (Math.random() < 0.008) {
            const isNightmare = (agent.stress ?? 0) > SLEEP_CONFIG.NIGHTMARE_STRESS_THRESHOLD && Math.random() < 0.6;
            
            if (isNightmare) {
                agent.stress += 15;
                eventBus.emit('db:writeMemory', 'low', agent.id, worldState.currentTick, "Woke up from a nightmare.");
                return { isDirty: true, nextState: 'fsm_idle' }; // WAKE UP SCREAMING
            } else {
                agent.mood += 5;
                // Good dream doesn't wake you up
            }
        }
        return Status.SUCCESS;
    },

    WakeUp: (agent, { reason }) => {
        if (agent.lod === 1) console.log(`[${agent.name}] Waking up: ${reason}`);
        
        // Buffs/Debuffs
        if (!agent.status_effects) agent.status_effects = [];
        agent.status_effects = agent.status_effects.filter(e => e.type !== 'EXHAUSTED');
        
        if (reason === 'Fully Rested') {
            agent.status_effects.push({ type: 'WELL_RESTED', duration: 240, magnitude: 0.8 });
        } else if (reason === 'Noise') {
            agent.status_effects.push({ type: 'GROGGY', duration: 60, magnitude: 1.2 });
        }

        if (agent.intentionStack) agent.intentionStack.pop();
        return { isDirty: true, nextState: 'fsm_idle' };
    }
};

const Conditions = {
    IsAlarmRinging: (agent, { hour }) => {
        if (!agent.job || !agent.job.startHour) return false;
        // Wake up 1 hour before work
        const wakeHour = agent.job.startHour - 1;
        return (hour === wakeHour);
    },

    IsLoudNoise: (agent, { localEnv }) => {
        // Deep sleepers ignore noise
        if (agent.stateContext.sleepDepthTicks > 60 && Math.random() < 0.5) return false;
        return (localEnv.noise ?? 0) > SLEEP_CONFIG.NOISE_WAKE_THRESHOLD;
    },

    IsFullyRested: (agent) => (agent.energy ?? 0) >= SLEEP_CONFIG.WAKE_THRESHOLD,

    IsStarving: (agent) => (agent.hunger ?? 0) > 90
};

// === 2. BEHAVIOR TREE ===

const SleepingTree = new Sequence([
    new Action(Actions.InitializeSleep),
    
    new Selector([
        // PRIORITY 1: FORCED WAKE
        new Sequence([
            new Condition(Conditions.IsAlarmRinging),
            new Action((a) => Actions.WakeUp(a, { reason: 'Work Alarm' }))
        ]),
        new Sequence([
            new Condition(Conditions.IsLoudNoise),
            new Action((a) => Actions.WakeUp(a, { reason: 'Noise' }))
        ]),
        new Sequence([
            new Condition(Conditions.IsStarving),
            new Action((a) => Actions.WakeUp(a, { reason: 'Hunger' }))
        ]),

        // PRIORITY 2: NATURAL WAKE
        new Sequence([
            new Condition(Conditions.IsFullyRested),
            new Action((a) => Actions.WakeUp(a, { reason: 'Fully Rested' }))
        ]),

        // PRIORITY 3: SLEEP
        new Sequence([
            new Action(Actions.RegenerateStats),
            new Action(Actions.DreamLogic) // Can trigger nightmare wake-up
        ])
    ])
]);

// === 3. STATE CLASS ===

export class SleepingState extends BaseState {
    enter(agent) {
        super.enter(agent);
        this._updateActivityFromState(agent);
        // We defer initialization to the Tree Action "InitializeSleep" 
        // to handle reloads/checkpoints gracefully.
    }

    tick(agent, hour, localEnv, worldState) {
        // Skip standard decay logic
        super.tick(agent, hour, localEnv, worldState, { skipEnergy: true, skipBoredom: true, skipStressCalculation: true });

        const context = { hour, localEnv, worldState, transition: null };
        const status = SleepingTree.execute(agent, context);

        if (context.transition) return context.transition;

        return { isDirty: (worldState.currentTick % 30 === 0), walOp: null };
    }
}