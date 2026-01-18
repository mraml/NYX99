import { BaseState } from './BaseState.js';
import { Selector, Sequence, Condition, Action, Status } from '../BehaviorTreeCore.js';
import { GAME_BALANCE } from '../../data/balance.js';
import eventBus from '../../engine/eventBus.js';

const SLEEP_CONFIG = {
    BASE_REGEN: 5.0,
    DEEP_SLEEP_MULTIPLIER: 1.5,
    REM_THRESHOLD_TICKS: 10,
    WAKE_THRESHOLD: 99.5, // Force almost full energy before natural wake
    NOISE_WAKE_THRESHOLD: 0.85,
    NIGHTMARE_STRESS_THRESHOLD: 60,
    WAKE_COOLDOWN_TICKS: 16 // ~4 hours minimum awake time (unless exhausted)
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

    WakeUp: (agent, { reason, worldState }) => {
        if (agent.lod === 1) console.log(`[${agent.name}] Waking up: ${reason}`);
        
        // Record wake time to prevent immediate re-sleeping
        agent.lastWakeTick = worldState.currentTick;

        // Buffs/Debuffs
        if (!agent.status_effects) agent.status_effects = [];
        agent.status_effects = agent.status_effects.filter(e => e.type !== 'EXHAUSTED');
        
        if (reason === 'Fully Rested') {
            // WELL_RESTED: 64 ticks (~16 hours) duration, 0.5 magnitude (halves energy decay)
            agent.status_effects.push({ type: 'WELL_RESTED', duration: 64, magnitude: 0.5 });
        } else if (reason === 'Noise') {
            agent.status_effects.push({ type: 'GROGGY', duration: 60, magnitude: 1.2 });
        }

        if (agent.intentionStack) agent.intentionStack.pop();
        return { isDirty: true, nextState: 'fsm_idle' };
    }
};

const Conditions = {
    // New check: Prevents "micro-sleeps" where agent enters state, ticks once, and leaves
    ShouldSleep: (agent, { hour, worldState }) => {
        // If exhausted (<10), always sleep
        if ((agent.energy ?? 0) < 10) return true;
        
        // If already sleeping (initialized), stay asleep until wake condition
        if (agent.stateContext.sleepDepthTicks !== undefined) return true;

        // Check cooldown (Are we awake?)
        const lastWake = agent.lastWakeTick || -999;
        const ticksSinceWake = worldState.currentTick - lastWake;
        
        // Prevent going back to sleep too soon unless it's proper night time
        if (ticksSinceWake < SLEEP_CONFIG.WAKE_COOLDOWN_TICKS) {
             const isNight = (hour >= 23 || hour < 5);
             if (!isNight) return false;
        }
        return true;
    },

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
    // Step 0: Pre-check (Bail if we shouldn't be here)
    new Selector([
        new Condition(Conditions.ShouldSleep),
        new Action((agent) => {
            // Bail out action
            if (agent.intentionStack) agent.intentionStack.pop();
            return { isDirty: true, nextState: 'fsm_idle' };
        })
    ]),

    new Action(Actions.InitializeSleep),
    
    new Selector([
        // PRIORITY 1: FORCED WAKE
        new Sequence([
            new Condition(Conditions.IsAlarmRinging),
            new Action((a, ctx) => Actions.WakeUp(a, { reason: 'Work Alarm', worldState: ctx.worldState }))
        ]),
        new Sequence([
            new Condition(Conditions.IsLoudNoise),
            new Action((a, ctx) => Actions.WakeUp(a, { reason: 'Noise', worldState: ctx.worldState }))
        ]),
        new Sequence([
            new Condition(Conditions.IsStarving),
            new Action((a, ctx) => Actions.WakeUp(a, { reason: 'Hunger', worldState: ctx.worldState }))
        ]),

        // PRIORITY 2: NATURAL WAKE
        new Sequence([
            new Condition(Conditions.IsFullyRested),
            new Action((a, ctx) => Actions.WakeUp(a, { reason: 'Fully Rested', worldState: ctx.worldState }))
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