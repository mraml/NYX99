import { BaseState } from './BaseState.js';
import { Selector, Sequence, Condition, Action, Status } from '../BehaviorTreeCore.js';
import { isAgentWorkShift } from '../agentUtilities.js';
import eventBus from '../eventBus.js';
import worldGraph from '../../data/worldGraph.js';

// === 1. LEAF NODES ===

const Actions = {
    // Consolidated "Check Needs" Action
    // Instead of hardcoded time checks in Conditions, we score needs here.
    // This allows for flexible, persona-driven behavior.
    EvaluatNeeds: (agent, { hour }) => {
        const p = agent.persona || {};
        
        // 1. Calculate Urgency Scores (0-100+)
        
        // HUNGER
        let hungerScore = agent.hunger || 0;
        // Meal time multiplier (Breakfast, Lunch, Dinner)
        const isMealTime = (hour >= 7 && hour <= 9) || (hour >= 12 && hour <= 14) || (hour >= 18 && hour <= 20);
        if (isMealTime) hungerScore *= 1.5;
        if (hungerScore > 90) hungerScore *= 2.0; // Critical survival

        // ENERGY
        let energyScore = 100 - (agent.energy || 0);
        // Circadian Rhythm logic:
        // Night Owls (Extroversion > 0.7?) might stay up later.
        // For baseline realism: Night = High Sleep Urgency.
        const isNight = (hour >= 23 || hour < 6);
        if (isNight) energyScore *= 2.0; // Tiredness hits harder at night
        if (energyScore > 90) energyScore *= 2.0; // Passing out

        // SOCIAL
        let socialScore = 100 - (agent.social || 0);
        if (p.extroversion > 0.7) socialScore *= 1.2; // Extroverts need it more
        if (isNight) socialScore *= 0.5; // Less likely to socialize at 3 AM (unless Party Animal)

        // 2. Pick the Winner
        // Threshold: Need must be significant (> 50 weighted) to act
        const THRESHOLD = 50;
        
        // Priority Winner
        let winner = null;
        let maxScore = -1;

        if (hungerScore > THRESHOLD && hungerScore > maxScore) {
            winner = 'eat';
            maxScore = hungerScore;
        }
        if (energyScore > THRESHOLD && energyScore > maxScore) {
            winner = 'sleep';
            maxScore = energyScore;
        }
        
        // Work Override (Highest Priority if Shift)
        if (isAgentWorkShift(agent, hour)) {
            return { isDirty: true, nextState: 'fsm_working' };
        }

        // Apply Transition
        if (winner === 'eat') return { isDirty: true, nextState: 'fsm_eating' };
        if (winner === 'sleep') return { isDirty: true, nextState: 'fsm_sleeping' };
        
        // If nothing urgent, continue to other idle behaviors
        return Status.FAILURE; // "Needs not met, try next tree node"
    },

    SeekHousing: (agent) => {
        if (agent.lod === 1) console.log(`[${agent.name}] Idle and homeless. Looking for home.`);
        return { isDirty: true, nextState: 'fsm_acquire_housing' };
    },
    
    SeekMaintenance: (agent) => {
        return { isDirty: true, nextState: 'fsm_maintenance' };
    },

    SeekFun: (agent) => {
        const isExtrovert = (agent.persona?.extroversion ?? 0.5) > 0.6;
        if (isExtrovert && Math.random() < 0.7) {
            return { isDirty: true, nextState: 'fsm_socializing' };
        }
        return { isDirty: true, nextState: 'fsm_recreation' };
    },

    DoIdleBehavior: (agent, { localEnv, worldState }) => {
        const patience = agent.persona?.conscientiousness ?? 0.5;
        let boredomPenalty = (patience < 0.3) ? 4.0 : 2.0;
        agent.boredom = Math.max(0, (agent.boredom ?? 0) - boredomPenalty);

        if ((agent.perceivedAgents?.length || 0) > 0) {
            agent.boredom += 0.5;
        }

        // [FIX] Update activity string for UI so they don't say "Idling" forever
        // Pick a random idle activity from the YAML logic (simulated here)
        if (!agent.currentActivityName || agent.currentActivityName === 'idling') {
             // In a real implementation, we'd query the Activity Library.
             // For now, simple text updates:
             const idleActs = ["Daydreaming", "People Watching", "Checking Pager", "Stretching"];
             agent.currentActivity = idleActs[Math.floor(Math.random() * idleActs.length)];
        }

        return Status.SUCCESS;
    }
};

const Conditions = {
    IsHomeless: (agent) => !agent.homeLocationId,
    
    IsHouseDirty: (agent) => {
        if (!agent.homeLocationId || agent.locationId !== agent.homeLocationId) return false;
        const node = worldGraph.nodes[agent.homeLocationId];
        return node && node.condition < 40;
    },

    IsBored: (agent) => (agent.boredom ?? 0) < 20 
};

// === 2. BEHAVIOR TREE ===

const IdleTree = new Selector([
    // 1. Critical Survival (Homelessness)
    new Sequence([
        new Condition(Conditions.IsHomeless),
        new Action(Actions.SeekHousing)
    ]),

    // 2. Needs & Obligations Evaluation (The "Brain")
    // This replaces rigid IsTired/IsHungry/IsWork checks with a weighted scorer
    new Action(Actions.EvaluatNeeds),

    // 3. Maintenance (Chores) - Only if needs are met
    new Sequence([
        new Condition(Conditions.IsHouseDirty),
        new Action(Actions.SeekMaintenance)
    ]),

    // 4. Recreation (Boredom)
    new Sequence([
        new Condition(Conditions.IsBored),
        new Action(Actions.SeekFun)
    ]),

    // 5. Default
    new Action(Actions.DoIdleBehavior)
]);

// === 3. STATE CLASS ===

export class IdleState extends BaseState {
    enter(agent) {
        super.enter(agent);
        this._updateActivityFromState(agent);
    }

    tick(agent, hour, localEnv, worldState) {
        super.tick(agent, hour, localEnv, worldState); 

        const context = { hour, localEnv, worldState, transition: null };
        const status = IdleTree.execute(agent, context);

        if (context.transition) return context.transition;

        return { isDirty: (worldState.currentTick % 10 === 0), walOp: null };
    }
}