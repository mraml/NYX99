import { BaseState } from './BaseState.js';
import { Sequence, Action, Status } from '../BehaviorTreeCore.js';
import { GAME_BALANCE } from '../../data/balance.js';
import worldGraph from '../../data/worldGraph.js';

// === 1. LEAF NODES ===

const Actions = {
    PrepareMeal: (agent, context) => {
        // Just verify we can eat. 
        // In this simplified version, we assume they find *something*.
        
        // Log setup
        if (agent.lod === 1) {
            console.log(`[${agent.name}] Eating a full meal.`);
        }
        
        // Cost logic (Simplified)
        if (agent.locationId !== agent.homeLocationId) {
             if ((agent.money || 0) > 10) agent.money -= 10;
        } else {
             // Home cooking (free/inventory for now to ensure they eat)
        }

        return Status.SUCCESS;
    },

    EatAndFinish: (agent, context) => {
        // 1. INSTANT FILL
        agent.hunger = 0;
        agent.mood = Math.min(100, (agent.mood || 0) + 10);
        
        if (!agent.status_effects) agent.status_effects = [];

        // 2. LONG LASTING BUFF (6 Hours = 24 Ticks)
        // Magnitude 0.1 means hunger decays at 10% speed (90% reduction)
        agent.status_effects.push({ 
            type: 'WELL_FED', 
            duration: 24, 
            magnitude: 0.1 
        });
        
        // 3. EXIT
        if (agent.intentionStack) agent.intentionStack.pop();
        return { isDirty: true, nextState: 'fsm_idle' };
    }
};

// === 2. BEHAVIOR TREE (Simplified) ===

const EatingTree = new Sequence([
    new Action(Actions.PrepareMeal),
    new Action(Actions.EatAndFinish)
]);

// === 3. STATE CLASS ===

export class EatingState extends BaseState {
    enter(agent) {
        super.enter(agent);
        this._updateActivityFromState(agent);
    }

    tick(agent, hour, localEnv, worldState) {
        // Skip hunger decay while in this state
        super.tick(agent, hour, localEnv, worldState, { skipHunger: true });

        const context = { hour, localEnv, worldState, transition: null };
        const status = EatingTree.execute(agent, context);

        if (context.transition) return context.transition;
        
        return { isDirty: true, walOp: null };
    }
}