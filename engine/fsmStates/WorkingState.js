import { BaseState } from './BaseState.js';
import { Selector, Sequence, Condition, Action, Chance, Status } from '../BehaviorTreeCore.js';
import { isAgentWorkShift } from '../agentUtilities.js';

// === 1. DEFINE LEAVES (REUSABLE LOGIC) ===

const Conditions = {
    IsShiftOver: (agent, { hour }) => !isAgentWorkShift(agent, hour),
    
    IsBurnedOut: (agent) => (agent.stress > 90),
    
    IsDistracted: (agent, { localEnv }) => 
        (localEnv.noise > 0.7 || (agent.perceivedAgents?.length > 3 && agent.persona.extroversion < 0.3))
};

const Actions = {
    PayWages: (agent, context) => {
        // Calculate earnings: Hourly wage * Hours worked
        // Default to minimum wage if undefined
        const hourlyWage = (agent.job?.salary || 20000) / 2000; // Salary / ~2000 work hours/year
        const ticksWorked = agent.stateContext.ticksWorked || 0;
        const hoursWorked = ticksWorked / 4; // 15 min ticks
        
        if (hoursWorked > 0) {
            const earnings = hourlyWage * hoursWorked;
            agent.money = (agent.money || 0) + earnings;
            
            // Optional: Log payment
            if (agent.lod === 1) {
                console.log(`[${agent.name}] Earned $${earnings.toFixed(2)} for ${hoursWorked.toFixed(1)} hours of work.`);
            }
            
            return { isDirty: true, walOp: { op: 'AGENT_EARN_WAGE', data: { amount: earnings } } };
        }
        return Status.SUCCESS;
    },

    LeaveWork: (agent) => {
        if (agent.intentionStack) agent.intentionStack.pop();
        // Return transition data. The Tree engine will bubble this up via context.transition
        return { isDirty: true, nextState: 'fsm_idle' }; 
    },

    DoActualWork: (agent) => {
        // Standard work logic
        agent.stateContext.ticksWorked = (agent.stateContext.ticksWorked || 0) + 1;
        agent.stress = Math.min(100, (agent.stress || 0) + 0.05);
        
        // Chance for bonus
        if (Math.random() < 0.01) {
            agent.money = (agent.money || 0) + 10;
            return { isDirty: true, walOp: { op: 'AGENT_EARN_BONUS', data: { amount: 10 } } };
        }
        return Status.SUCCESS;
    },

    SlackOff: (agent) => {
        // [FIX] Removed state transition. Slacking off now happens AT WORK.
        // It relieves stress but doesn't earn "ticksWorked" (or earns less).
        
        agent.mood = Math.min(100, (agent.mood || 0) + 1);
        agent.stress = Math.max(0, (agent.stress || 0) - 0.5);
        
        // Flavor log occasionally
        if (agent.lod === 1 && Math.random() < 0.05) {
             console.log(`[${agent.name}] Zoning out at work.`);
        }
        
        return Status.SUCCESS;
    }
};

// === 2. DEFINE TREES (STATIC DEFINITIONS) ===

// Tree A: The Standard Employee
const StandardWorkerTree = new Selector([
    // 1. High Priority: Burnout
    new Sequence([
        new Condition(Conditions.IsBurnedOut),
        new Action(Actions.PayWages), // Get paid for partial shift
        new Action(Actions.LeaveWork)
    ]),
    // 2. High Priority: Shift End
    new Sequence([
        new Condition(Conditions.IsShiftOver),
        new Action(Actions.PayWages), // Get paid for full shift
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

// === 3. THE REFACTORED STATE ===

export class WorkingState extends BaseState {
    
    enter(agent) {
        super.enter(agent);
        
        // [FIX] Set Activity Name based on Job Type to source from activities.yaml
        // This ensures flavor text like "typing at desk" appears instead of generic strings.
        const title = (agent.job?.title || '').toLowerCase();
        if (title.includes('officer') || title.includes('police')) {
            agent.currentActivityName = 'patrolling (police)';
        } else if (title.includes('teacher') || title.includes('professor')) {
            agent.currentActivityName = 'teaching class (teacher)';
        } else if (title.includes('bartender') || title.includes('waiter') || title.includes('server')) {
            agent.currentActivityName = 'working (service)';
        } else {
            agent.currentActivityName = 'working (office)';
        }
        
        this._updateActivityFromState(agent);
        
        // Initialize context variables needed for the tree
        agent.stateContext.ticksWorked = 0; // Track time for payment
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
        const behaviorTree = StandardWorkerTree;

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
        
        return { isDirty, walOp: context.walOp || null };
    }
}