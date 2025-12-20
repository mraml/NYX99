import { BaseState } from './BaseState.js';
import worldGraph from '../../data/worldGraph.js';
import eventBus from '../eventBus.js';

/**
 * CommutingState.js
 * [REF] Stateless Flyweight Version
 * Critical Change: Pathing data moved to agent.stateContext
 */
export class CommutingState extends BaseState {
    
    // [REF] Added agent param
    enter(agent) {
        super.enter(agent);
        this._updateActivityFromState(agent);
        
        // [REF] Move stateful properties to agent.stateContext
        agent.stateContext.travelCostPaid = false; 
        agent.stateContext.isSneaking = false;
        agent.stateContext.transportMode = 'transit'; 
        agent.stateContext.currentPath = null;
        
        // Critical: Set user-facing display name for planning/start phase
        // Since we can't set this.displayName on the shared instance, we set it on agent directly?
        // Or we rely on _updateActivityFromState reading a constant?
        // For now, let's assume agent.currentActivity is sufficient, as BaseState sets it.
    }
    
    // [REF] Added agent param
    tick(agent, hour, localEnv, worldState) {
        // FIX: Standardize FSM state names used in transition/check
        if (agent.state === 'fsm_commuting') {
            return this._handleCommuting(agent);
        } 
        
        if (agent.state === 'fsm_in_transit') {
            return this._handleInTransit(agent, hour, localEnv, worldState);
        }

        return { isDirty: false, walOp: null }; 
    }

    // [REF] Added agent param
    exit(agent) {
        super.exit(agent);
        // Cleanup handled by FSM wiping stateContext, but explicit nulling is fine
    }

    // [REF] Added agent param
    _validateDestinationForGoal(node, goal, agent) {
        if (!node) return false;
        switch (goal) {
            case 'fsm_sleeping': return node.type === 'home';
            case 'fsm_working':
            case 'fsm_job_hunting': return node.key === agent.workLocationId; 
            case 'fsm_acquire_housing': return node.type === 'home';
            default:
                return (node.affordances ?? []).some(a => a.action === goal);
        }
    }

    // [REF] Added agent param
    _handleCommuting(agent) {
        // --- LOGIC FOR FINDING PATH AND SETTING UP TRANSIT ---

        if (!agent.locationId) {
            if (agent.homeLocationId) {
                agent.locationId = agent.homeLocationId;
                this.log(`[${agent.name}] Location was NULL. Grounding agent at home.`);
            } else {
                this.log(`[${agent.name}] Location was NULL and no home base found. Aborting travel.`);
                // Clean intentions manually since we don't have FSM reference
                agent.intentionStack = [];
                return { isDirty: true, walOp: { op: 'AGENT_STATE_UPDATE', data: { state: 'fsm_idle' } }, nextState: 'fsm_idle' };
            }
        }
        
        // [REF] Use stateContext.currentPath
        if (!agent.stateContext.currentPath) {
            // Check 1: Already at the target?
            if (!agent.targetLocationId || agent.locationId === agent.targetLocationId) {
                const intention = agent.intentionStack?.[agent.intentionStack.length - 1];
                const goal = intention?.goal || 'fsm_idle';
                if (agent.intentionStack) agent.intentionStack.pop(); 
                
                return { isDirty: true, walOp: { op: 'AGENT_ARRIVE', data: { location: agent.locationId, state: goal } }, nextState: goal };
            }

            // Pathfinding
            agent.stateContext.currentPath = worldGraph.findPath(agent.locationId, agent.targetLocationId);

            if (!agent.stateContext.currentPath) {
                this.log(`[${agent.name}] FAILED to find path from ${agent.locationId} to ${agent.targetLocationId}. Resetting.`);
                return { isDirty: true, walOp: { op: 'AGENT_STATE_UPDATE', data: { state: 'fsm_idle' } }, nextState: 'fsm_idle' };
            }
            
            // Remove the starting node
            if (agent.stateContext.currentPath.length > 0 && agent.stateContext.currentPath[0] === agent.locationId) {
                agent.stateContext.currentPath.shift();
            }
        }

        if ((agent.stateContext.currentPath?.length ?? 0) === 0) {
            const intention = agent.intentionStack?.[agent.intentionStack.length - 1];
            const goal = intention?.goal || 'fsm_idle';
            if (agent.intentionStack) agent.intentionStack.pop(); 
            
            return { isDirty: true, walOp: { op: 'AGENT_ARRIVE', data: { location: agent.locationId, state: goal } }, nextState: goal };
        }

        const nextNodeId = agent.stateContext.currentPath.shift();
        
        const travelTicks = worldGraph.getEdgeTravelTicks 
            ? worldGraph.getEdgeTravelTicks(agent.locationId, nextNodeId)
            : worldGraph.getTravelCost(agent.locationId, nextNodeId) / 1.5; 

        agent.transitFrom = agent.locationId;
        agent.transitTo = nextNodeId;
        agent.travelTimer = travelTicks;

        // Transition to travel state
        return { isDirty: true, walOp: { op: 'AGENT_STATE_UPDATE', data: { state: 'fsm_in_transit' } }, nextState: 'fsm_in_transit' };
    }

    // [REF] Added agent param
    _handleInTransit(agent, hour, localEnv, worldState) {
        super.tick(agent, hour, localEnv, worldState);
        let walOp = null;

        // --- 1. Payment & Mode Logic ---
        if (!agent.stateContext.travelCostPaid) {
            const travelCost = worldGraph.getEdgeTravelCost 
                ? worldGraph.getEdgeTravelCost(agent.transitFrom, agent.transitTo) 
                : worldGraph.getTravelCost(agent.transitFrom, agent.transitTo);

            if (travelCost <= 1) { 
                agent.stateContext.transportMode = 'walking';
            } else {
                agent.stateContext.transportMode = 'transit'; 
                
                if ((agent.money ?? 0) >= travelCost) {
                    agent.money = (agent.money ?? 0) - travelCost;
                    walOp = {
                        op: 'AGENT_TRAVEL',
                        data: { cost: travelCost, from: agent.transitFrom, to: agent.transitTo }
                    };
                } else {
                    agent.stateContext.isSneaking = true;
                    this.log(`[${agent.name}] Sneaking on transit...`);
                    agent.stress = Math.min(100, (agent.stress ?? 0) + 15);
                    walOp = { op: 'AGENT_TRAVEL', data: { cost: 0, from: agent.transitFrom, to: agent.transitTo, sneaking: true } };
                }
            }
            agent.stateContext.travelCostPaid = true;
        }

        // --- 2. Physical Exertion ---
        if (agent.stateContext.transportMode === 'walking') {
            agent.energy = Math.max(0, (agent.energy ?? 0) - 0.2); 
            
            const weather = worldState.weather?.weather || 'Clear';
            if (weather.includes('Rain') || weather.includes('Snow')) {
                 agent.mood = Math.max(0, (agent.mood ?? 0) - 0.8); 
                 agent.energy -= 0.1; 
            }
        } else {
            agent.energy = Math.max(0, (agent.energy ?? 0) - 0.05);
            
            const isRushHour = (hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19);
            if (isRushHour) agent.stress = Math.min(100, (agent.stress ?? 0) + 0.5);
        }

        // --- 3. Flavor Events ---
        if (Math.random() < 0.005) {
            this._triggerTravelEvent(agent, worldState, agent.stateContext.transportMode);
        }

        // --- 4. Movement Logic ---
        agent.travelTimer = (agent.travelTimer ?? 0) - 1;

        if (agent.travelTimer <= 0) {
            const destinationNode = worldGraph.nodes[agent.transitTo];
            const originalGoal = agent.intentionStack?.[agent.intentionStack.length - 1]?.goal || 'fsm_idle';

            if (!destinationNode) {
                this.log(`[${agent.name}] Arrived at invalid destination: ${agent.transitTo}.`);
                agent.locationId = agent.homeLocationId;
                return { isDirty: true, walOp: { op: 'AGENT_STATE_UPDATE', data: { state: 'fsm_idle' } }, nextState: 'fsm_idle' };
            }
            
            // CRITICAL FIX: Update locationId on arrival
            agent.locationId = agent.transitTo; 

            // Validation Check: If we arrived but aren't at the final destination for the goal, continue commuting
            const pathLengthRemaining = agent.stateContext.currentPath?.length ?? 0;
            if (pathLengthRemaining > 0) {
                agent.transitFrom = null;
                agent.transitTo = null;
                agent.stateContext.travelCostPaid = false;
                
                // Continue moving to the next hop
                return { isDirty: true, walOp: { op: 'AGENT_STATE_UPDATE', data: { state: 'fsm_commuting' } }, nextState: 'fsm_commuting' };
            }
            
            // Final Arrival: Complete the intention and transition to the goal state
            if (agent.intentionStack) agent.intentionStack.pop(); 
            
            return { isDirty: true, walOp: { op: 'AGENT_ARRIVE', data: { location: agent.transitTo, state: originalGoal } }, nextState: originalGoal };
        }

        return { isDirty: true, walOp };
    }

    // [REF] Added agent param
    _triggerTravelEvent(agent, worldState, mode) {
        let events = [];
        if (mode === 'walking') {
            events = [
                { text: "stepped in a puddle", mood: -5 },
                { text: "found a dollar on the sidewalk", mood: 5, money: 1 },
                { text: "saw a cute dog", mood: 5 },
                { text: "got splashed by a car", mood: -15, stress: 10 }
            ];
        } else {
             events = [
                { text: "saw a breakdancer spinning on cardboard", mood: 5 },
                { text: "heard a heated argument about pizza toppings", stress: 2 },
                { text: "saw a rat dragging a whole slice of pizza", mood: 2 },
                { text: "smelled something weird", mood: -2 }
            ];
        }

        const evt = events[Math.floor(Math.random() * events.length)];
        eventBus.emitNow('db:writeMemory', 'low', agent.id, worldState.currentTick, `Commuting (${mode}): ${evt.text}`);
        
        if (evt.mood) agent.mood = Math.max(0, Math.min(100, (agent.mood ?? 0) + evt.mood));
        if (evt.stress) agent.stress = Math.max(0, Math.min(100, (agent.stress ?? 0) + evt.stress));
        if (evt.money) agent.money = (agent.money ?? 0) + evt.money;
    }
}