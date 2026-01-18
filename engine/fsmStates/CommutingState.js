import { BaseState } from './BaseState.js';
import { Selector, Sequence, Condition, Action, Status } from '../BehaviorTreeCore.js';
import worldGraph from '../../data/worldGraph.js';
import eventBus from '../eventBus.js';

// === 1. LEAF NODES ===

const Actions = {
    // --- PLANNING ---
    FindPath: (agent, context) => {
        if (!agent.targetLocationId) {
            // Error state: No target
            if (agent.homeLocationId) agent.targetLocationId = agent.homeLocationId;
            else return Actions.AbortCommute(agent, "No target and no home.");
        }

        if (agent.locationId === agent.targetLocationId) {
            // Already there
            return Status.SUCCESS; 
        }

        // Calculate
        const path = worldGraph.findPath(agent.locationId, agent.targetLocationId);
        if (!path) {
            return Actions.AbortCommute(agent, "No path found.");
        }

        // Clean path (remove current node if present)
        if (path.length > 0 && path[0] === agent.locationId) path.shift();
        
        agent.stateContext.currentPath = path;
        return Status.SUCCESS;
    },

    AbortCommute: (agent, reason) => {
        if (agent.lod === 1) console.log(`[${agent.name}] Aborting commute: ${reason}`);
        agent.intentionStack = []; 
        return { isDirty: true, nextState: 'fsm_idle' };
    },

    // --- EXECUTION ---
    SetupNextHop: (agent) => {
        const path = agent.stateContext.currentPath;
        if (!path || path.length === 0) return Status.FAILURE; // Should be caught by Arrive logic

        const nextNodeId = path.shift();
        
        // Calculate Cost
        const travelTicks = worldGraph.getEdgeTravelTicks 
            ? worldGraph.getEdgeTravelTicks(agent.locationId, nextNodeId)
            : worldGraph.getTravelCost(agent.locationId, nextNodeId) / 1.5; 

        // Set Transit State
        agent.transitFrom = agent.locationId;
        agent.transitTo = nextNodeId;
        agent.travelTimer = travelTicks;
        agent.stateContext.isTraveling = true;
        agent.stateContext.travelCostPaid = false;

        return { isDirty: true, walOp: { op: 'AGENT_STATE_UPDATE', data: { state: 'fsm_in_transit' } } };
    },

    HandleTransitTick: (agent, { hour, worldState }) => {
        let walOp = null;

        // 1. Pay Logic (Run once per hop)
        if (!agent.stateContext.travelCostPaid) {
            const cost = worldGraph.getTravelCost(agent.transitFrom, agent.transitTo);
            
            if (cost <= 1) {
                agent.stateContext.transportMode = 'walking';
            } else {
                if ((agent.money ?? 0) >= cost) {
                    agent.money -= cost;
                    agent.stateContext.transportMode = 'transit';
                    walOp = { op: 'AGENT_TRAVEL', data: { cost, from: agent.transitFrom, to: agent.transitTo } };
                } else {
                    agent.stateContext.transportMode = 'transit_sneaking';
                    agent.stress = Math.min(100, (agent.stress ?? 0) + 15);
                    walOp = { op: 'AGENT_TRAVEL', data: { cost: 0, from: agent.transitFrom, to: agent.transitTo, sneaking: true } };
                }
            }
            agent.stateContext.travelCostPaid = true;
        }

        // 2. Exertion Logic
        if (agent.stateContext.transportMode === 'walking') {
            agent.energy = Math.max(0, (agent.energy ?? 0) - 0.2);
            // Weather check could go here
        } else {
            agent.energy = Math.max(0, (agent.energy ?? 0) - 0.05);
        }

        // 3. Time Logic
        agent.travelTimer = (agent.travelTimer ?? 0) - 1;

        // 4. Flavor Event
        if (Math.random() < 0.005) {
            const evt = agent.stateContext.transportMode === 'walking' ? "stepped in a puddle" : "saw a rat";
            agent.mood -= 2;
        }

        return { isDirty: true, walOp };
    },

    CompleteHop: (agent) => {
        // Arrived at intermediate node
        agent.locationId = agent.transitTo;
        agent.transitFrom = null;
        agent.transitTo = null;
        agent.stateContext.isTraveling = false;
        
        // If final destination, Arrival logic will handle it next tick
        return Status.SUCCESS;
    },

    // --- ARRIVAL ---
    ProcessArrival: (agent) => {
        // We are at the target
        const originalGoal = agent.intentionStack?.[agent.intentionStack.length - 1]?.goal || 'fsm_idle';
        if (agent.intentionStack) agent.intentionStack.pop();

        return { 
            isDirty: true, 
            walOp: { op: 'AGENT_ARRIVE', data: { location: agent.locationId, state: originalGoal } }, 
            nextState: originalGoal 
        };
    }
};

const Conditions = {
    IsAtDestination: (agent) => (agent.locationId === agent.targetLocationId),
    HasPath: (agent) => (agent.stateContext.currentPath && agent.stateContext.currentPath.length > 0),
    IsTraveling: (agent) => (agent.stateContext.isTraveling && agent.travelTimer > 0),
    IsHopComplete: (agent) => (agent.stateContext.isTraveling && agent.travelTimer <= 0)
};

// === 2. BEHAVIOR TREE ===

const CommutingTree = new Selector([
    // 1. Are we there yet? (Final Arrival)
    new Sequence([
        new Condition(Conditions.IsAtDestination),
        new Action(Actions.ProcessArrival)
    ]),

    // 2. Are we currently moving between nodes? (In Transit)
    new Selector([
        // A. Transit Finished -> Update Location
        new Sequence([
            new Condition(Conditions.IsHopComplete),
            new Action(Actions.CompleteHop)
        ]),
        // B. Still Moving -> Tick
        new Sequence([
            new Condition(Conditions.IsTraveling),
            new Action(Actions.HandleTransitTick)
        ])
    ]),

    // 3. Do we need a path? (Planning)
    new Sequence([
        // If we aren't traveling and don't have a path...
        // Note: Using Inverter checks effectively
        new Action(Actions.FindPath) // This action returns SUCCESS if path found, FAILURE/Action if error
    ]),

    // 4. Ready to start next leg? (Execution)
    new Sequence([
        new Condition(Conditions.HasPath),
        new Action(Actions.SetupNextHop)
    ])
]);

// === 3. STATE CLASS ===

export class CommutingState extends BaseState {
    enter(agent) {
        super.enter(agent);
        this._updateActivityFromState(agent);
        
        // Initialize State Context
        // Note: We don't clear path if it exists, to allow resuming? 
        // Safer to clear to ensure recalculation against current graph.
        if (!agent.stateContext.isTraveling) {
            agent.stateContext.currentPath = null;
            agent.stateContext.isTraveling = false;
        }
    }

    tick(agent, hour, localEnv, worldState) {
        // Note: We handle base tick manually inside Transit logic if needed, 
        // or call super() but with overrides.
        // For commuting, we usually skip standard boredom/social decay.
        super.tick(agent, hour, localEnv, worldState, { skipBoredom: true });

        const context = { hour, localEnv, worldState, transition: null };
        const status = CommutingTree.execute(agent, context);

        if (context.transition) return context.transition;
        
        return { isDirty: context.isDirty || false, walOp: context.walOp };
    }
}