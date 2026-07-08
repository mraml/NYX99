import { BaseState } from './BaseState.js';
import { Selector, Sequence, Condition, Action, Chance, Status } from '../BehaviorTreeCore.js';
import {
  isAgentWorkShift,
  getWorkingTagForJobTitle,
  assignWorkLocationByJob,
  transitionWithCommuteIfNeeded,
} from '../agentUtilities.js';
import { GAME_BALANCE } from '../../data/balance.js';
import { updateCurrentActivity } from '../agent/agentActivity.js';
import worldGraph from '../../data/worldGraph.js';

// === 1. DEFINE LEAVES (REUSABLE LOGIC) ===

const T = GAME_BALANCE.THRESHOLDS;

const Conditions = {
    IsShiftOver: (agent, { hour }) => !isAgentWorkShift(agent, hour),
    
    IsBurnedOut: (agent) => (agent.stress > T.BURNOUT_THRESHOLD),
    
    IsDistracted: (agent, { localEnv }) => 
        (localEnv.noise > 0.7 || (agent.perceivedAgents?.length > 3 && agent.persona.extroversion < 0.3)),

    IsLunchTime: (agent, { hour }) => {
        if (!agent.stateContext) agent.stateContext = {};
        const h = Math.floor(hour ?? 12);
        const start = T.LUNCH_BREAK_START_HOUR ?? 12;
        const end = T.LUNCH_BREAK_END_HOUR ?? 14;
        if (h < start || h >= end) return false;
        if (agent.stateContext.lunchBreakTaken) return false;
        return (agent.hunger ?? 0) > (T.LUNCH_BREAK_HUNGER_THRESHOLD ?? 35);
    },
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
        if (!agent.stateContext) agent.stateContext = {};
        agent.stateContext.workSessionDone = true;
        if (agent.intentionStack) agent.intentionStack.pop();
        return { isDirty: true, nextState: 'fsm_idle' };
    },

    TakeLunchBreak: (agent, context) => {
        if (!agent.stateContext) agent.stateContext = {};
        const hourlyWage = (agent.job?.salary || 20000) / 2000;
        const ticksWorked = agent.stateContext.ticksWorked || 0;
        const hoursWorked = ticksWorked / 4;
        let walOp = null;
        if (hoursWorked > 0) {
            const earnings = hourlyWage * hoursWorked;
            agent.money = (agent.money || 0) + earnings;
            walOp = { op: 'AGENT_EARN_WAGE', data: { amount: earnings, partial: true } };
        }
        agent.stateContext.ticksWorked = 0;
        agent.stateContext.lunchBreakTaken = true;
        if (agent.intentionStack) agent.intentionStack.pop();
        return { isDirty: true, nextState: 'fsm_eating', walOp };
    },

    DoActualWork: (agent, context) => {
        agent.stateContext.ticksWorked = (agent.stateContext.ticksWorked || 0) + 1;
        agent.stress = Math.min(100, (agent.stress || 0) + 0.05);

        // Periodically rotate the action string so agents don't stay frozen on the same line
        if (Math.random() < 0.05 && agent.stateContext.workingTag) {
            updateCurrentActivity(agent, agent.stateContext.workingTag, context?.hour || 12);
        }

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
    // 3. Lunch break (paid partial, then eat off-site / cafeteria)
    new Sequence([
        new Condition(Conditions.IsLunchTime),
        new Action(Actions.TakeLunchBreak)
    ]),
    // 4. Distractions (Low Chance to slack off)
    new Sequence([
        new Condition(Conditions.IsDistracted),
        new Chance(0.3, new Action(Actions.SlackOff))
    ]),
    // 5. Default: Work
    new Action(Actions.DoActualWork)
]);

// === 3. THE REFACTORED STATE ===

export class WorkingState extends BaseState {
    
    enter(agent) {
        super.enter(agent);

        if (agent.lifeStage === 'child' || agent.lifeStage === 'elder') {
            agent.state = agent.lifeStage === 'elder' ? 'fsm_retired' : 'fsm_idle';
            return;
        }
        
        const workingTag = getWorkingTagForJobTitle(agent.job?.title || '');

        const hour = agent.matrix?.worldTime?.getHours() || 12;
        updateCurrentActivity(agent, workingTag, hour);

        agent.stateContext.ticksWorked = 0;
        agent.stateContext.workingTag = workingTag;
        agent.stateContext.workSessionDone = false;

        if (agent.workLocationId && !worldGraph.nodes[agent.workLocationId]) {
            const fixed = assignWorkLocationByJob(agent);
            if (fixed) agent.workLocationId = fixed;
        }
    }

    tick(agent, hour, localEnv, worldState) {
        super.tick(agent, hour, localEnv, worldState); // Biological decay

        if (agent.workLocationId && !worldGraph.nodes[agent.workLocationId]) {
            const fixed = assignWorkLocationByJob(agent);
            if (fixed) agent.workLocationId = fixed;
        }

        if (
            agent.workLocationId &&
            isAgentWorkShift(agent, hour) &&
            agent.locationId !== agent.workLocationId
        ) {
            return transitionWithCommuteIfNeeded(agent, agent.state, {
                reason: 'work_site_commute',
                currentTick: worldState.currentTick,
            });
        }

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