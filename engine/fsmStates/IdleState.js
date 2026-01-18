import { BaseState } from './BaseState.js';
import { Selector, Sequence, Condition, Action, Status } from '../BehaviorTreeCore.js';
import eventBus from '../eventBus.js';

// === 1. LEAF NODES ===

const Actions = {
    SeekHousing: (agent) => {
        if (agent.lod === 1) console.log(`[${agent.name}] Idle and homeless. Looking for home.`);
        return { isDirty: true, nextState: 'fsm_acquire_housing' };
    },

    SeekFood: (agent) => {
        return { isDirty: true, nextState: 'fsm_eating' };
    },

    SeekSleep: (agent) => {
        return { isDirty: true, nextState: 'fsm_sleeping' };
    },

    DoIdleBehavior: (agent, { localEnv, worldState }) => {
        // --- 1. Boredom Calculation ---
        const patience = agent.persona?.conscientiousness ?? 0.5;
        const energy = agent.energy ?? 50;
        
        // Impatient or High Energy -> Bored faster
        let boredomPenalty = (patience < 0.3 || energy > 80) ? 4.0 : 2.0;
        if (patience > 0.7) boredomPenalty = 1.0; // Patient

        agent.boredom = Math.max(0, (agent.boredom ?? 0) - boredomPenalty);

        // --- 2. People Watching ---
        const crowdCount = agent.perceivedAgents?.length || 0;
        if (crowdCount > 0) {
            agent.boredom = Math.min(100, (agent.boredom ?? 0) + 0.5);
             if ((agent.persona?.extroversion ?? 0.5) > 0.6) {
                 agent.social = Math.min(100, (agent.social ?? 0) + 0.1);
            }
        }

        // --- 3. Flavor (Daydreaming) ---
        if (Math.random() < 0.02) {
             if (agent.lod === 1) console.log(`[${agent.name}] Is daydreaming.`);
             
             if (Math.random() < 0.1) {
                 eventBus.emitNow('db:writeMemory', 'low', agent.id, worldState.currentTick, `Had an internal thought.`);
             }
             return { isDirty: true };
        }

        return Status.SUCCESS;
    }
};

const Conditions = {
    // Check if we have an explicit intention (from player or event)
    HasIntention: (agent) => {
        return (agent.intentionStack && agent.intentionStack.length > 0);
    },

    IsHomeless: (agent) => !agent.homeLocationId,
    
    // Updated: Critical hunger overrides schedule, otherwise prefer meal times
    IsHungryAndMealTime: (agent, { hour }) => {
        const hunger = agent.hunger ?? 0;
        if (hunger > 90) return true; // Starving overrides everything
        
        // Meal Times: Breakfast (7-9), Lunch (12-14), Dinner (18-20)
        const isMealTime = (hour >= 7 && hour <= 9) || (hour >= 12 && hour <= 14) || (hour >= 18 && hour <= 20);
        return (hunger > 60 && isMealTime);
    },
    
    // Updated: Critical fatigue overrides schedule, otherwise prefer night
    IsTiredAndNightTime: (agent, { hour }) => {
        const energy = agent.energy ?? 0;
        if (energy < 10) return true; // Passing out
        
        // Sleep at night (22:00 - 05:00)
        const isNight = (hour >= 22 || hour < 5);
        return (energy < 40 && isNight);
    }
};

// === 2. BEHAVIOR TREE ===

const IdleTree = new Selector([
    // 1. Proactive Needs (The "I should probably..." Logic)
    new Sequence([
        new Condition(Conditions.IsHomeless),
        new Action(Actions.SeekHousing)
    ]),
    new Sequence([
        new Condition(Conditions.IsHungryAndMealTime),
        new Action(Actions.SeekFood)
    ]),
    new Sequence([
        new Condition(Conditions.IsTiredAndNightTime),
        new Action(Actions.SeekSleep)
    ]),

    // 2. Default Idling
    new Action(Actions.DoIdleBehavior)
]);

// === 3. STATE CLASS ===

export class IdleState extends BaseState {
    enter(agent) {
        super.enter(agent);
        this._updateActivityFromState(agent);
    }

    tick(agent, hour, localEnv, worldState) {
        super.tick(agent, hour, localEnv, worldState); // Decay

        const context = { hour, localEnv, worldState, transition: null };
        const status = IdleTree.execute(agent, context);

        if (context.transition) return context.transition;

        return { isDirty: (worldState.currentTick % 10 === 0), walOp: null };
    }
}