import { BaseState } from './BaseState.js';
import { Selector, Sequence, Condition, Action, Status } from '../BehaviorTreeCore.js';
import { GAME_BALANCE } from '../../data/balance.js';
import { isAgentWorkShift } from '../agentUtilities.js'; // Import isAgentWorkShift
import eventBus from '../../engine/eventBus.js';

const SLEEP_CONFIG = {
    DURATION_TICKS: 32, // 8 Hours (Assuming 15m ticks)
    MAX_DURATION_TICKS: 48, // 12 Hours max sleep
    BUFF_DURATION: 64,  // 16 Hours of reduced energy decay
    WAKE_THRESHOLD: 99.5,
};

// === 1. LEAF NODES ===

const Actions = {
    PrepareSleep: (agent, context) => {
        // Initialize sleep timer if not present
        if (agent.stateContext.sleepTicks === undefined) {
            agent.stateContext.sleepTicks = 0;
            if (agent.lod === 1) {
                console.log(`[${agent.name}] Going to sleep.`);
            }
        }
        return Status.SUCCESS;
    },

    SleepProcess: (agent, context) => {
        agent.stateContext.sleepTicks = (agent.stateContext.sleepTicks || 0) + 1;

        // Visual Regen (Gradual increase for UI)
        agent.energy = Math.min(100, (agent.energy || 0) + 3);
        
        return Status.SUCCESS; // Continue to checks
    },

    CheckWakeConditions: (agent, { hour, worldState }) => {
        const ticks = agent.stateContext.sleepTicks;
        let wakeReason = null;

        // 1. Work Alarm (Wake up 1 hour before shift)
        // We check if work starts in the next hour (current hour + 1)
        const nextHour = (hour + 1) % 24;
        if (isAgentWorkShift(agent, nextHour) && !isAgentWorkShift(agent, hour)) {
             wakeReason = "Work Alarm";
        }
        
        // 2. Max Duration (Oversleeping safety)
        if (ticks >= SLEEP_CONFIG.MAX_DURATION_TICKS) {
            wakeReason = "Overslept";
        }

        // 3. Natural Wake (Duration + Fully Rested)
        if (ticks >= SLEEP_CONFIG.DURATION_TICKS && agent.energy >= SLEEP_CONFIG.WAKE_THRESHOLD) {
            wakeReason = "Fully Rested";
        }

        if (wakeReason) {
            // --- FINISH SLEEP ---
            agent.energy = 100;
            agent.stress = Math.max(0, (agent.stress || 0) - 20);
            
            if (!agent.status_effects) agent.status_effects = [];

            // Apply Well Rested
            agent.status_effects = agent.status_effects.filter(e => e.type !== 'WELL_RESTED');
            agent.status_effects.push({ 
                type: 'WELL_RESTED', 
                duration: SLEEP_CONFIG.BUFF_DURATION, 
                magnitude: 0.2 
            });
            
            agent.lastWakeTick = worldState.currentTick;

            if (agent.lod === 1) {
                console.log(`[${agent.name}] Woke up: ${wakeReason}`);
            }

            if (agent.intentionStack) agent.intentionStack.pop();
            
            // If waking for work, we can optionally transition directly to Idle 
            // (IdleState will then pick up Work on next tick)
            return { isDirty: true, nextState: 'fsm_idle' };
        }

        return Status.RUNNING; // Keep sleeping
    }
};

// === 2. BEHAVIOR TREE ===

const SleepingTree = new Sequence([
    new Action(Actions.PrepareSleep),
    new Action(Actions.SleepProcess),
    new Action(Actions.CheckWakeConditions) // Consolidated wake logic
]);

// === 3. STATE CLASS ===

export class SleepingState extends BaseState {
    enter(agent) {
        super.enter(agent);
        this._updateActivityFromState(agent);
        agent.stateContext.sleepTicks = 0;
    }

    tick(agent, hour, localEnv, worldState) {
        // Skip energy decay while in this state
        super.tick(agent, hour, localEnv, worldState, { skipEnergy: true, skipStressCalculation: true });

        const context = { hour, localEnv, worldState, transition: null };
        const status = SleepingTree.execute(agent, context);

        if (context.transition) return context.transition;
        // If Actions.CheckWakeConditions returned an object (transition), execute handles it differently?
        // BehaviorTreeCore Action usually returns Status or object. 
        // If it returns object, it sets context.transition.
        // So we check context.transition here.

        return { isDirty: (worldState.currentTick % 10 === 0), walOp: null };
    }
}