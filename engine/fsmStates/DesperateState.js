import { BaseState } from './BaseState.js';
import { Selector, Sequence, Condition, Action, Status } from '../BehaviorTreeCore.js';
import { GAME_BALANCE } from '../../data/balance.js';
import worldGraph from '../../data/worldGraph.js';

// === 1. LEAF NODES ===

const Actions = {
    InitDesperation: (agent) => {
        if (agent.stateContext.ticksInState !== undefined) return Status.SUCCESS;
        agent.stateContext.ticksInState = 0;
        agent.stateContext.maxDesperationTicks = 120; // Hard cap
        if (agent.lod === 1) console.log(`[${agent.name}] Is desperate! No money, no food.`);
        return Status.SUCCESS;
    },

    RestFromExhaustion: (agent) => {
        if (agent.lod === 1) console.log(`[${agent.name}] Too exhausted to scrounge. Giving up.`);
        return { isDirty: true, nextState: 'fsm_idle' };
    },

    EmergencyEat: (agent) => {
        if (agent.lod === 1) console.log(`[${agent.name}] Starving while desperate. Seeking scraps.`);
        // Force transition to eating (EatingState handles 'scraps' if broke)
        return { isDirty: true, nextState: 'fsm_eating' };
    },

    CheckForRecovery: (agent) => {
        const foodCost = GAME_BALANCE.COSTS?.GROCERIES || 20; 
        if ((agent.money ?? 0) >= foodCost) {
            if (agent.lod === 1) console.log(`[${agent.name}] Scraped together enough cash. Heading to store.`);
            return { isDirty: true, nextState: 'fsm_shopping' };
        }
        return Status.FAILURE;
    },

    Relocate: (agent, { worldState }) => {
        // Move every 20 ticks if unsuccessful
        if (agent.stateContext.ticksInState % 20 !== 0) return Status.FAILURE;

        const target = worldGraph.findRandomLocationByType('park') || worldGraph.findRandomLocationByType('subway_station');
        
        if (target && target.key !== agent.locationId) {
            agent.targetLocationId = target.key;
            return { isDirty: true, nextState: 'fsm_commuting' };
        }
        return Status.FAILURE;
    },

    Scavenge: (agent) => {
        agent.stateContext.ticksInState++;
        agent.stress = Math.min(100, (agent.stress ?? 0) + 0.5);
        agent.mood = Math.max(-100, (agent.mood ?? 0) - 0.5);

        // 10% Chance to find money
        if (Math.random() < 0.1) {
            const foundMoney = Math.floor(Math.random() * 5) + 1;
            agent.money = (agent.money ?? 0) + foundMoney;
            return { isDirty: true, walOp: { op: 'AGENT_FOUND_MONEY', data: { amount: foundMoney } } };
        }
        
        return Status.RUNNING;
    }
};

const Conditions = {
    IsExhausted: (agent) => {
        return (agent.stateContext.ticksInState >= agent.stateContext.maxDesperationTicks);
    },
    IsStarving: (agent) => (agent.hunger ?? 0) > 95
};

// === 2. BEHAVIOR TREE ===

const DesperateTree = new Sequence([
    new Action(Actions.InitDesperation),

    new Selector([
        // 0. CRITICAL: Starvation Override (Prevent Death Spiral)
        new Sequence([
            new Condition(Conditions.IsStarving),
            new Action(Actions.EmergencyEat)
        ]),

        // 1. Give up if too tired
        new Sequence([
            new Condition(Conditions.IsExhausted),
            new Action(Actions.RestFromExhaustion)
        ]),

        // 2. Success? (Have we found enough money?)
        new Action(Actions.CheckForRecovery),

        // 3. Need to move?
        new Action(Actions.Relocate),

        // 4. Scrounge
        new Action(Actions.Scavenge)
    ])
]);

// === 3. STATE CLASS ===

export class DesperateState extends BaseState {
    enter(agent) {
        super.enter(agent);
        this._updateActivityFromState(agent);
        agent.stateContext.ticksInState = undefined; // Trigger Init
    }

    tick(agent, hour, localEnv, worldState) {
        super.tick(agent, hour, localEnv, worldState);

        const context = { hour, localEnv, worldState, transition: null };
        const status = DesperateTree.execute(agent, context);

        if (context.transition) return context.transition;

        return { isDirty: (worldState.currentTick % 10 === 0), walOp: context.walOp };
    }
}