import { BaseState } from './BaseState.js';
import { Selector, Sequence, Condition, Action, Status } from '../BehaviorTreeCore.js';
import { ACTIVITIES_MAP } from '../../data/dataLoader.js';
import { GAME_BALANCE } from '../../data/balance.js';
import { isAgentWorkShift } from '../agentUtilities.js';
import eventBus from '../eventBus.js';

// === 1. LEAF NODES ===

const Actions = {
    InitRecreation: (agent, context) => {
        if (agent.stateContext.ticksInState !== undefined) return Status.SUCCESS;
        
        // Params passed from FSM transition or Intent
        agent.stateContext.duration = agent.stateContext.duration || 60; // Default 1 hour
        agent.stateContext.ticksInState = 0;
        
        if (agent.lod === 1) console.log(`[${agent.name}] Starting fun: ${agent.currentActivityName}`);
        return Status.SUCCESS;
    },

    PerformActivity: (agent, { localEnv, worldState }) => {
        agent.stateContext.ticksInState++;

        const currentActDef = ACTIVITIES_MAP[agent.currentActivityName] || {};
        const tags = currentActDef.interest_tags || [];
        const isActive = tags.includes('active') || tags.includes('creative');

        // Logic ported from old state
        let stressReduction = 0.5;
        let boredomReduction = 10;
        let energyCost = 0;

        if (isActive) {
            stressReduction *= 2.5;
            energyCost = 2.0;
        }

        // Apply
        agent.boredom = Math.max(0, (agent.boredom ?? 0) - boredomReduction);
        agent.stress = Math.max(0, (agent.stress ?? 0) - stressReduction);
        agent.energy = Math.max(0, (agent.energy ?? 0) - energyCost);
        agent.mood = Math.min(100, (agent.mood ?? 0) + GAME_BALANCE.REGEN.MOOD_BOOST_RECREATION);

        // Flavor
        if (Math.random() < 0.01) {
            eventBus.emitNow('db:writeMemory', 'low', agent.id, worldState.currentTick, `Having a great time ${agent.currentActivityName}.`);
        }

        return Status.SUCCESS;
    },

    StopRecreation: (agent, { reason }) => {
        if (agent.lod === 1) console.log(`[${agent.name}] Stopping recreation: ${reason}`);
        if (agent.intentionStack) agent.intentionStack.pop();
        return { isDirty: true, nextState: 'fsm_idle' };
    }
};

const Conditions = {
    IsCurfew: (agent, { hour }) => (hour >= 2 && hour < 5),
    IsWorkStarting: (agent, { hour }) => isAgentWorkShift(agent, hour),
    
    IsFinished: (agent) => {
        const duration = agent.stateContext.duration;
        if (duration && agent.stateContext.ticksInState >= duration) return true;
        
        // Natural saturation
        if ((agent.boredom ?? 0) <= 5 && (agent.stress ?? 0) <= 10) return true;
        
        // Exhaustion check
        if ((agent.energy ?? 0) < 10) return true;
        
        return false;
    }
};

// === 2. BEHAVIOR TREE ===

const RecreationTree = new Sequence([
    new Action(Actions.InitRecreation),

    new Selector([
        // 1. MUST STOP Reasons
        new Sequence([
            new Condition(Conditions.IsCurfew),
            new Action((a) => Actions.StopRecreation(a, { reason: "Curfew" }))
        ]),
        new Sequence([
            new Condition(Conditions.IsWorkStarting),
            new Action((a) => Actions.StopRecreation(a, { reason: "Work Starting" }))
        ]),
        new Sequence([
            new Condition(Conditions.IsFinished),
            new Action((a) => Actions.StopRecreation(a, { reason: "Finished/Bored" }))
        ]),

        // 2. DO ACTIVITY
        new Action(Actions.PerformActivity)
    ])
]);

// === 3. STATE CLASS ===

export class RecreationState extends BaseState {
    enter(agent, params = {}) {
        super.enter(agent);
        this._updateActivityFromState(agent);
        // Note: We use params.context if passed from FSM, otherwise rely on Tree init
        if (params.context?.duration) agent.stateContext.duration = params.context.duration;
    }

    tick(agent, hour, localEnv, worldState) {
        super.tick(agent, hour, localEnv, worldState, { skipStressCalculation: true });

        const context = { hour, localEnv, worldState, transition: null };
        const status = RecreationTree.execute(agent, context);

        if (context.transition) return context.transition;
        
        return { isDirty: (worldState.currentTick % 10 === 0), walOp: null };
    }
}