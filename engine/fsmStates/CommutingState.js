import { BaseState } from './BaseState.js';
import { Selector, Sequence, Condition, Action, Status } from '../BehaviorTreeCore.js';
import worldGraph from '../../data/worldGraph.js';
import eventBus from '../../engine/eventBus.js';

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
        if (!path || path.length === 0) {
            // Fallback: If no path found, maybe just move directly to target if connected or as emergency
            // But for simulation realism, let's abort if unconnected.
            return Actions.AbortCommute(agent, "No path found.");
        }

        // Clean path (remove current node if present)
        if (path[0] === agent.locationId) path.shift();
        
        agent.stateContext.currentPath = path;
        
        if (agent.lod === 1) {
            console.log(`[${agent.name}] Planned route to ${agent.targetLocationId} (${path.length} stops)`);
        }
        
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
        // Standardized travel time: Distance * Multiplier (e.g. 15 mins per hop roughly)
        const dist = worldGraph.getDistance(agent.locationId, nextNodeId) || 1;
        const travelTicks = Math.max(1, Math.ceil(dist * 2)); // 2 ticks per unit distance

        // Set Transit State
        agent.transitFrom = agent.locationId;
        agent.transitTo = nextNodeId;
        agent.travelTimer = travelTicks;
        agent.stateContext.isTraveling = true;
        
        // Determine Mode (Simulated)
        // If distance is short (< 2), walk. Else, take subway/taxi.
        if (dist <= 2) {
            agent.stateContext.transportMode = 'walking';
            agent.currentActivity = 'Walking to ' + nextNodeId;
        } else {
            agent.stateContext.transportMode = 'transit';
            agent.currentActivity = 'Taking subway to ' + nextNodeId;
            // Fare logic
            if ((agent.money || 0) >= 2.75) {
                agent.money -= 2.75;
            }
        }

        return { isDirty: true, walOp: { op: 'AGENT_STATE_UPDATE', data: { state: 'fsm_in_transit' } } };
    },

    HandleTransitTick: (agent, { hour, worldState }) => {
        // 1. Time Logic
        agent.travelTimer = (agent.travelTimer ?? 0) - 1;

        // 2. Weather Impact (from Beliefs)
        const weather = (agent.beliefs && agent.beliefs.weather) ? agent.beliefs.weather : 'Clear';
        const isBadWeather = weather.includes('Rain') || weather.includes('Snow');

        if (agent.stateContext.transportMode === 'walking') {
            agent.energy = Math.max(0, (agent.energy ?? 0) - 0.5); // Walking is tiring
            if (isBadWeather) {
                agent.mood = Math.max(0, (agent.mood ?? 0) - 1.0);
            }
        } else {
            agent.energy = Math.max(0, (agent.energy ?? 0) - 0.1); // Sitting on train is easy
        }

        return { isDirty: true, walOp: null };
    },

    CompleteHop: (agent) => {
        // Arrived at intermediate node
        // Teleport prevention: We only update locationId HERE, after timer finishes.
        agent.locationId = agent.transitTo;
        agent.transitFrom = null;
        agent.transitTo = null;
        agent.stateContext.isTraveling = false;
        
        // If final destination, Arrival logic will handle it next tick via IsAtDestination check
        return Status.SUCCESS;
    },

    // --- ARRIVAL ---
    ProcessArrival: (agent) => {
        // We are at the target
        const originalGoal = agent.intentionStack?.[agent.intentionStack.length - 1]?.goal || 'fsm_idle';
        
        // If we were commuting to do something specific (from intention), we are done commuting.
        // Pop the 'fsm_commuting' intention if it was pushed? 
        // Actually, usually the intention IS the goal (e.g. 'fsm_working'), and we just use CommutingState to get there.
        // So we transition to that goal state now.
        
        if (agent.lod === 1) {
            console.log(`[${agent.name}] Arrived at ${agent.locationId}. Switching to ${originalGoal}.`);
        }

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
    // 1. Check if we have arrived at the FINAL destination
    new Sequence([
        new Condition(Conditions.IsAtDestination),
        new Action(Actions.ProcessArrival)
    ]),

    // 2. Handle Active Travel (Moving between nodes)
    new Selector([
        // A. Hop Finished? -> Update Location
        new Sequence([
            new Condition(Conditions.IsHopComplete),
            new Action(Actions.CompleteHop)
        ]),
        // B. Still Moving? -> Tick Timer
        new Sequence([
            new Condition(Conditions.IsTraveling),
            new Action(Actions.HandleTransitTick)
        ])
    ]),

    // 3. Planning (If not traveling and not at dest)
    new Sequence([
        new Action(Actions.FindPath) // Returns SUCCESS if path found/exists
    ]),

    // 4. Start Next Leg (If we have a path)
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
        if (!agent.stateContext.isTraveling) {
            agent.stateContext.currentPath = null;
            agent.stateContext.isTraveling = false;
            agent.stateContext.transportMode = 'transit';
        }
    }

    tick(agent, hour, localEnv, worldState) {
        // Skip standard boredom decay while commuting (focused)
        super.tick(agent, hour, localEnv, worldState, { skipBoredom: true });

        const context = { hour, localEnv, worldState, transition: null };
        const status = CommutingTree.execute(agent, context);

        if (context.transition) return context.transition;
        
        // Update UI every tick during travel to show progress
        return { isDirty: true, walOp: context.walOp };
    }
}