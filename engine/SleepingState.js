import { BaseState } from './BaseState.js';
import { Sequence, Action, Status } from '../BehaviorTreeCore.js';
import { GAME_BALANCE } from '../../data/balance.js';
import eventBus from '../../engine/eventBus.js';

const SLEEP_CONFIG = {
    DURATION_TICKS: 32, // 8 Hours (Assuming 15m ticks)
    BUFF_DURATION: 64,  // 16 Hours of reduced energy decay
};

// === 1. LEAF NODES ===

const Actions = {
    PrepareSleep: (agent, context) => {
        // Initialize sleep timer if not present
        if (agent.stateContext.sleepTicks === undefined) {
            agent.stateContext.sleepTicks = 0;
            if (agent.lod === 1) {
                console.log(`[${agent.name}] Going to sleep for 8 hours.`);
            }
        }
        return Status.SUCCESS;
    },

    SleepProcess: (agent, context) => {
        agent.stateContext.sleepTicks = (agent.stateContext.sleepTicks || 0) + 1;

        // Visual Regen (Gradual increase for UI)
        // We force 100 at the end, but this looks nice on the dashboard
        agent.energy = Math.min(100, (agent.energy || 0) + 3);
        
        // Check Duration
        if (agent.stateContext.sleepTicks < SLEEP_CONFIG.DURATION_TICKS) {
            // Wake up early if critical emergency? (Optional, skipping for simplicity)
            return Status.RUNNING;
        }

        // --- FINISH SLEEP ---
        
        // 1. INSTANT FILL
        agent.energy = 100;
        agent.stress = Math.max(0, (agent.stress || 0) - 20); // Stress relief
        
        if (!agent.status_effects) agent.status_effects = [];

        // 2. LONG LASTING BUFF
        // Magnitude 0.2 means energy decays at 20% speed (80% reduction)
        agent.status_effects = agent.status_effects.filter(e => e.type !== 'WELL_RESTED');
        agent.status_effects.push({ 
            type: 'WELL_RESTED', 
            duration: SLEEP_CONFIG.BUFF_DURATION, 
            magnitude: 0.2 
        });
        
        // Record wake time
        agent.lastWakeTick = context.worldState.currentTick;

        if (agent.lod === 1) {
            console.log(`[${agent.name}] Woke up fully rested.`);
        }

        // 3. EXIT
        if (agent.intentionStack) agent.intentionStack.pop();
        return { isDirty: true, nextState: 'fsm_idle' };
    }
};

// === 2. BEHAVIOR TREE (Simplified) ===

const SleepingTree = new Sequence([
    new Action(Actions.PrepareSleep),
    new Action(Actions.SleepProcess)
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

        // Update UI occasionally
        return { isDirty: (worldState.currentTick % 10 === 0), walOp: null };
    }
}