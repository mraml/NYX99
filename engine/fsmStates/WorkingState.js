import { BaseState } from './BaseState.js';
import { Selector, Sequence, Condition, Action, Chance, Status } from '../BehaviorTreeCore.js';
import { isAgentWorkShift } from '../agentUtilities.js';

// === 1. DEFINE LEAVES (REUSABLE LOGIC) ===

const Conditions = {
    IsShiftOver: (agent, { hour }) => !isAgentWorkShift(agent, hour),
    
    IsBurnedOut: (agent) => (agent.stress > 90),
    
    IsJobHunting: (agent) => agent.stateContext.isSeekingEmployment,
    
    IsJobSearchFailed: (agent) => 
        (agent.stateContext.jobHuntDuration >= agent.stateContext.MAX_JOB_HUNT_TICKS) || 
        (agent.energy < 20),
    
    IsDistracted: (agent, { localEnv }) => 
        (localEnv.noise > 0.7 || (agent.perceivedAgents?.length > 3 && agent.persona.extroversion < 0.3))
};

const Actions = {
    LeaveWork: (agent) => {
        if (agent.intentionStack) agent.intentionStack.pop();
        // Return transition data. The Tree engine will bubble this up via context.transition
        return { isDirty: true, nextState: 'fsm_idle' }; 
    },

    PerformJobSearch: (agent) => {
        agent.stateContext.jobHuntDuration = (agent.stateContext.jobHuntDuration || 0) + 1;
        agent.stress = Math.min(100, (agent.stress || 0) + 0.2);
        
        // Log occasionally
        if (Math.random() < 0.1) {
             return { isDirty: true, walOp: { op: 'AGENT_JOB_HUNT', data: { progress: agent.stateContext.jobHuntDuration } } };
        }
        return Status.RUNNING; // Stays in this state
    },

    DoActualWork: (agent) => {
        // Standard work logic
        agent.stress = Math.min(100, (agent.stress || 0) + 0.05);
        
        // Chance for bonus
        if (Math.random() < 0.01) {
            agent.money = (agent.money || 0) + 10;
            return { isDirty: true, walOp: { op: 'AGENT_EARN_BONUS', data: { amount: 10 } } };
        }
        return Status.SUCCESS;
    },

    SlackOff: (agent) => {
        agent.mood = Math.min(100, (agent.mood || 0) + 1);
        agent.stress = Math.max(0, (agent.stress || 0) - 0.1);
        
        if (Math.random() < 0.1) {
            // Transition out for recreation
            return { isDirty: true, nextState: 'fsm_recreation' };
        }
        return { isDirty: true };
    }
};

// === 2. DEFINE TREES (STATIC DEFINITIONS) ===

// Tree A: The Standard Employee
const StandardWorkerTree = new Selector([
    // 1. High Priority: Burnout
    new Sequence([
        new Condition(Conditions.IsBurnedOut),
        new Action(Actions.LeaveWork)
    ]),
    // 2. High Priority: Shift End
    new Sequence([
        new Condition(Conditions.IsShiftOver),
        new Action(Actions.LeaveWork)
    ]),
    // 3. Distractions (Low Chance to slack off)
    new Sequence([
        new Condition(Conditions.IsDistracted),
        new Chance(0.3, new Action(Actions.SlackOff))
    ]),
    // 4. Default: Work
    new Action(Actions.DoActualWork)
]);

// Tree B: The Job Hunter
const JobHunterTree = new Selector([
    new Sequence([
        new Condition(Conditions.IsJobSearchFailed),
        new Action(Actions.LeaveWork)
    ]),
    new Action(Actions.PerformJobSearch)
]);

// === 3. THE REFACTORED STATE ===

export class WorkingState extends BaseState {
    
    enter(agent) {
        super.enter(agent);
        this._updateActivityFromState(agent);
        
        // Initialize context variables needed for the tree
        agent.stateContext.jobHuntDuration = 0;
        agent.stateContext.MAX_JOB_HUNT_TICKS = 60; // Configurable
    }

    tick(agent, hour, localEnv, worldState) {
        super.tick(agent, hour, localEnv, worldState); // Biological decay

        // 1. Setup the Context for the Tree
        // We add a 'transition' property that the Actions can write to
        const context = { 
            hour, 
            localEnv, 
            worldState,
            transition: null // Actions will write { nextState: '...' } here
        };

        // 2. Select the correct static tree logic
        let behaviorTree;
        if (agent.stateContext.isSeekingEmployment) {
            behaviorTree = JobHunterTree;
        } else {
            behaviorTree = StandardWorkerTree;
        }

        // 3. Execute the Tree
        const status = behaviorTree.execute(agent, context);
        
        // 4. Handle Results
        
        // A) Did the tree request a State Transition?
        if (context.transition) {
            return context.transition;
        }
        
        // B) Normal tick updates
        let isDirty = (worldState.currentTick % 10 === 0);
        if (status === Status.RUNNING) {
             isDirty = true;
        }
        
        return { isDirty, walOp: null };
    }
}