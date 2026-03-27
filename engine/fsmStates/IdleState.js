import { BaseState } from './BaseState.js';
import { Selector, Sequence, Condition, Action, Status } from '../BehaviorTreeCore.js';
import { isAgentWorkShift } from '../agentUtilities.js';
import eventBus from '../eventBus.js';
import worldGraph from '../../data/worldGraph.js';
import { GAME_BALANCE } from '../../data/balance.js';

function isValidPlan(plan) {
    return !!plan && typeof plan === 'object' && typeof plan.type === 'string' && Number.isFinite(plan.tick);
}

function isExecutableMeetPlan(plan) {
    return plan.type === 'MEET_AGENT' &&
        typeof plan.locationId === 'string' &&
        plan.locationId.length > 0 &&
        typeof plan.targetAgentId === 'string' &&
        plan.targetAgentId.length > 0;
}

// === 1. LEAF NODES ===

const Actions = {
    // Consolidated "Check Needs" Action
    EvaluateNeeds: (agent, { hour }) => {
        const p = agent.persona || {};
        
        let hungerScore = agent.hunger || 0;
        const isMealTime = (hour >= 7 && hour <= 9) || (hour >= 12 && hour <= 14) || (hour >= 18 && hour <= 20);
        
        if (isMealTime) hungerScore *= 1.5;
        if (hungerScore > 90) hungerScore *= 2.0; 

        let energyScore = 100 - (agent.energy || 0);
        const isNight = (hour >= 23 || hour < 6);
        
        if (isNight) energyScore *= 2.0; 
        if (energyScore > 90) energyScore *= 2.0; 

        // 2. Pick the Winner
        const THRESHOLD = GAME_BALANCE.THRESHOLDS.ACTION_THRESHOLD;
        
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
        
        // Survival Override (Critical Needs bypass work shift)
        const isCriticalHunger = hungerScore > GAME_BALANCE.THRESHOLDS.CRITICAL_HUNGER;
        const isCriticalEnergy = energyScore > GAME_BALANCE.THRESHOLDS.CRITICAL_ENERGY_SCORE;
        
        if (isCriticalHunger || isCriticalEnergy) {
            if (winner === 'eat') return { isDirty: true, nextState: 'fsm_eating' };
            if (winner === 'sleep') return { isDirty: true, nextState: 'fsm_sleeping' };
        }

        // Work Override
        if (isAgentWorkShift(agent, hour)) {
            return { isDirty: true, nextState: 'fsm_working' };
        }

        if (winner === 'eat') return { isDirty: true, nextState: 'fsm_eating' };
        if (winner === 'sleep') return { isDirty: true, nextState: 'fsm_sleeping' };
        
        return Status.FAILURE; 
    },

    SeekHousing: (agent) => {
        if (agent.lod === 1) console.log(`[${agent.name}] Idle and homeless. Looking for home.`);
        return { isDirty: true, nextState: 'fsm_acquire_housing' };
    },
    
    SeekMaintenance: (agent) => {
        return { isDirty: true, nextState: 'fsm_maintenance' };
    },

    // NEW: Morning Routine Actions
    DoMorningRoutine: (agent) => {
        // Simple sequential routine simulation
        if (!agent.stateContext.morningRoutineStep) {
            agent.stateContext.morningRoutineStep = 'shower';
        }

        const step = agent.stateContext.morningRoutineStep;
        
        if (step === 'shower') {
            agent.currentActivityName = 'taking shower'; // Matches activities.yaml
            agent.stateContext.morningRoutineStep = 'brush_teeth';
            // Flavor log
            if (agent.lod === 1) console.log(`[${agent.name}] Taking a morning shower.`);
            return Status.RUNNING; // Take a tick to do this
        } else if (step === 'brush_teeth') {
            agent.currentActivityName = 'brushing teeth';
            agent.stateContext.morningRoutineStep = 'dress';
            return Status.RUNNING;
        } else if (step === 'dress') {
            agent.currentActivityName = 'getting dressed';
            agent.stateContext.morningRoutineStep = 'done';
            // Mark as "Ready" for the day
            agent.stateContext.isReadyForDay = true;
            return Status.RUNNING;
        } 
        
        return Status.SUCCESS; // Routine complete
    },

    SeekFun: (agent) => {
        const isExtrovert = (agent.persona?.extroversion ?? 0.5) > 0.6;
        if (isExtrovert && Math.random() < 0.7) {
            return { isDirty: true, nextState: 'fsm_socializing' };
        }
        return { isDirty: true, nextState: 'fsm_recreation' };
    },

    ExecutePlan: (agent, { worldState }) => {
        const plan = agent.plans[0];
        if (!isValidPlan(plan)) {
            agent.plans.shift();
            return Status.FAILURE;
        }

        if (isExecutableMeetPlan(plan) && worldGraph.nodes[plan.locationId]) {
            agent.plans.shift(); // Consume only when executable
            agent.targetLocationId = plan.locationId;
            agent.partnerId = plan.targetAgentId;
            agent.intentionStack = [{ goal: 'fsm_socializing' }];
            if (agent.lod === 1) console.log(`[${agent.name}] Executing plan to meet agent at ${plan.locationId}`);
            return { isDirty: true, nextState: 'fsm_commuting' };
        }
        // Drop malformed or non-executable plan to avoid retry loops.
        agent.plans.shift();
        return Status.FAILURE;
    },

    DoIdleBehavior: (agent, { localEnv, worldState }) => {
        const patience = agent.persona?.conscientiousness ?? 0.5;
        let boredomPenalty = (patience < 0.3) ? 4.0 : 2.0;
        agent.boredom = Math.max(0, (agent.boredom ?? 0) - boredomPenalty);

        if ((agent.perceivedAgents?.length || 0) > 0) {
            agent.boredom += 0.5;
        }

        if (!agent.currentActivityName || agent.currentActivityName === 'idling') {
             // Use valid activities from yaml
             const idleActs = ['making coffee', 'reading newspaper', 'checking email', 'listening to music'];
             agent.currentActivityName = idleActs[Math.floor(Math.random() * idleActs.length)];
        }

        return Status.SUCCESS;
    }
};

const Conditions = {
    HasPlan: (agent, { worldState }) => {
        if (!agent.plans || agent.plans.length === 0) return false;
        // Drop stale/malformed plans so they do not churn forever.
        agent.plans = agent.plans.filter((plan) => {
            if (!isValidPlan(plan)) return false;
            return plan.tick >= worldState.currentTick - 96;
        });
        if (agent.plans.length === 0) return false;
        agent.plans.sort((a, b) => a.tick - b.tick);
        // Plan is active if we are within 20 ticks (5 hours) of the time, or past it
        return worldState.currentTick >= agent.plans[0].tick - 20;
    },

    IsHomeless: (agent) => !agent.homeLocationId,
    
    IsHouseDirty: (agent) => {
        if (!agent.homeLocationId || agent.locationId !== agent.homeLocationId) return false;
        const node = worldGraph.nodes[agent.homeLocationId];
        return node && node.condition < 40;
    },

    // NEW: Check if we just woke up and need to get ready
    NeedsMorningRoutine: (agent, { hour }) => {
        // Reset "Ready" flag at night (e.g., 4 AM)
        if (hour === 4) agent.stateContext.isReadyForDay = false;

        // If it's morning (6am-10am) and we aren't ready, do routine
        const isMorning = (hour >= 6 && hour <= 10);
        return isMorning && !agent.stateContext.isReadyForDay && agent.locationId === agent.homeLocationId;
    },

    IsBored: (agent) => (agent.boredom ?? 0) < 20 
};

// === 2. BEHAVIOR TREE ===

const IdleTree = new Selector([
    // 0. Priority: Plans & Commitments
    new Sequence([
        new Condition(Conditions.HasPlan),
        new Action(Actions.ExecutePlan)
    ]),

    // 1. Critical Survival (Homelessness)
    new Sequence([
        new Condition(Conditions.IsHomeless),
        new Action(Actions.SeekHousing)
    ]),

    // 2. Needs & Obligations Evaluation (The "Brain")
    new Action(Actions.EvaluateNeeds),

    // 3. Morning Routine (Before fun/chores)
    new Sequence([
        new Condition(Conditions.NeedsMorningRoutine),
        new Action(Actions.DoMorningRoutine)
    ]),

    // 4. Maintenance (Chores)
    new Sequence([
        new Condition(Conditions.IsHouseDirty),
        new Action(Actions.SeekMaintenance)
    ]),

    // 5. Recreation (Boredom)
    new Sequence([
        new Condition(Conditions.IsBored),
        new Action(Actions.SeekFun)
    ]),

    // 6. Default
    new Action(Actions.DoIdleBehavior)
]);

// === 3. STATE CLASS ===

export class IdleState extends BaseState {
    enter(agent) {
        super.enter(agent);
        this._updateActivityFromState(agent);
        // Ensure routine step is reset if we enter idle from sleep
        if (agent.stateContext.isReadyForDay === undefined) {
            agent.stateContext.isReadyForDay = false;
        }
        agent.stateContext.morningRoutineStep = null;
    }

    tick(agent, hour, localEnv, worldState) {
        super.tick(agent, hour, localEnv, worldState); 

        const context = { hour, localEnv, worldState, transition: null };
        const status = IdleTree.execute(agent, context);

        if (context.transition) return context.transition;

        return { isDirty: (worldState.currentTick % 10 === 0), walOp: null };
    }
}