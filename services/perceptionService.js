import worldGraph from '../data/worldGraph.js';

/**
 * perceptionService.js
 * * Runs the perception logic for an agent, updating their `beliefs` map.
 * This service acts as the bridge between the "true" world state and
 * what the agent *believes* to be true.
 */

const PERCEPTION_RADIUS = 1; // How many "nodes" away an agent can "see" (currently just their location)

/**
 * Updates the agent's beliefs about the world based on their current perceptions.
 * This function modifies the agent.beliefs object directly.
 * * @param {Agent} agent - The agent object (must be a full class instance or serialized object).
 * @param {object} worldState - The *true* world state from the Matrix.
 * @param {Map<string, number>} locationAgentCount - The *true* agent counts.
 */
export function runPerception(agent, worldState, locationAgentCount) {
    if (!agent) return;

    // Ensure the beliefs object exists
    if (!agent.beliefs) {
        agent.beliefs = {
            weather: 'unknown',
            locationStatus: {}, // key: locationId, value: 'open' | 'closed' | 'unknown'
            perceivedAgents: [], // list of agentIds in the same location
        };
    }
    
    const beliefs = agent.beliefs;
    const currentLocationId = agent.locationId;
    const currentLocation = worldGraph.nodes[currentLocationId];

    // 1. Perceive Current Location
    if (currentLocation) {
        // Agent is at a location (not in transit)
        
        // Perceive weather *only* if outdoors or near a window (simplified to outdoors)
        if (currentLocation.isOutdoors) {
            beliefs.weather = worldState.weather?.weather || 'unknown';
        } else {
            // If indoors, their belief persists. If they didn't know, it stays unknown.
            beliefs.weather = beliefs.weather || 'unknown';
        }

        // Perceive the status of the *current* location
        const isTrulyOpen = worldGraph.isLocationOpen(currentLocation);
        beliefs.locationStatus[currentLocationId] = isTrulyOpen ? 'open' : 'closed';

        // Perceive other agents at this location
        // We get this from the 'perceivedAgents' list prepared by the ActionScorer's context.
        // This is a bit of a circular dependency, but it's the most efficient way.
        // The 'agent.perceivedAgents' is populated by 'analyzeSocialContext' in the scorer.
        // We will just ensure the belief matches.
        beliefs.perceivedAgents = agent.perceivedAgents || [];

    } else {
        // Agent is in transit
        beliefs.perceivedAgents = [];
        // Weather belief persists while in transit
    }

    // 2. Memory Decay (Beliefs become "unknown" over time)
    // Agents slowly "forget" the status of locations they haven't visited.
    if (worldState.currentTick % 100 === 0) { // Run this check every 100 ticks
        for (const locationId in beliefs.locationStatus) {
            if (locationId !== currentLocationId) {
                // 10% chance to forget the status of a location they aren't at
                if (Math.random() < 0.1) {
                    beliefs.locationStatus[locationId] = 'unknown';
                }
            }
        }
    }
}