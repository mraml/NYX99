import {
  shouldLogThinking,
} from '../data/config.js';

import { runPerception } from './perceptionService.js';

/**
 * services/agentService.js
 * (FIXED v11.10: Critical Event Logging Visibility)
 */
export async function updateAgent(agent, matrix, hour) {

  // CRITICAL VALIDATION: fail fast if agent structure is invalid.
  // This prevents crashes when deserialization fails or if 'fsm' is missing.
  if (!agent || !agent.fsm || !agent.locationId) {
      console.error(`[agentService] Invalid agent detected (ID: ${agent?.id}). Skipping update.`);
      return { isDirty: false, walOp: null };
  }
  
  // OPTIMIZATION: Deduplicate worldState construction.
  // Instead of rebuilding this object for every agent (which is wasteful CPU/GC usage),
  // we check if a canonical version has already been created for this tick on the matrix instance.
  let worldState = matrix._derivedWorldState;

  if (!worldState || worldState.currentTick !== matrix.tickCount) {
      worldState = {
          currentTick: matrix.tickCount,
          // Use the CacheManager interface which exists on both Main and Worker threads
          agents: matrix.cacheManager?.getAllAgents ? matrix.cacheManager.getAllAgents() : [],
          // Access social context from the authoritative world state
          locationSocialContext: matrix.worldState?.locationSocialContext || new Map(), 
          // Access events from worldState
          world_events: matrix.worldState?.world_events || [],
          dayOfWeek: matrix.worldTime ? matrix.worldTime.getDay() : 0,
          environment: matrix.worldState?.environment,
          weather: matrix.worldState?.weather || { weather: 'Clear' } 
      };
      
      // Cache it on the matrix instance so subsequent agents in this tick reuse it
      matrix._derivedWorldState = worldState;
  }
  
  // Track state at start of tick to detect activity completions for history logging
  const startState = agent.state;

  // --- PHASE 1: BIOLOGY & PHYSICS (Restoring "Zombie" Logic) ---
  
  // 1. Decay Needs (Hunger, Energy, etc.)
  // CRITICAL FIX: Removed double-decay. 
  // BaseState.tick() -> agent._decayStats() is already called within fsm.tick().
  
  // 2. Sensory Processing
  // [REF] Wired in perceptionService to update agent beliefs (weather, crowding, nearby agents)
  runPerception(agent, worldState, matrix.locationAgentCount || {});

  // 3. Status Effects (Buffs/Debuffs)
  // MOVED: To ensure multipliers apply to the current tick's decay, we update effects 
  // AFTER decay happens (in Transit block or after FSM tick).

  // 4. Memory Consolidation (Periodic)
  // MOVED: To end of Phase 2.

  // 5. Movement Physics
  if (agent.inTransit || agent.travelTimer > 0) {
      if (typeof agent._handleMovement === 'function') {
          agent._handleMovement();
      }
      
      // FIX: Apply decay during transit. 
      // Since we skip FSM (where decay lives now), we must manually apply it here to prevent metabolic pausing.
      if (typeof agent._decayStats === 'function') {
          agent._decayStats(worldState);
      }

      // FIX: Update status effects AFTER decay so multipliers apply for this tick.
      if (typeof agent._updateStatusEffects === 'function') {
          agent._updateStatusEffects();
      }

      if (agent.inTransit || agent.travelTimer > 0) {
          return { isDirty: true, walOp: null };
      }
  }

  // --- PHASE 2: COGNITION (FSM & Decision Making) ---
  
  const locationNode = agent.matrix?.worldGraph?.nodes?.[agent.locationId];
  
  // FIX: Calculate light level based on hour
  const getLightLevel = (h) => {
      if (h >= 6 && h < 8) return 'dawn';
      if (h >= 8 && h < 18) return 'day';
      if (h >= 18 && h < 20) return 'dusk';
      return 'night';
  };

  // FIX: Populate complete environment data for States (Sleeping, etc)
  const localEnv = {
      noise: locationNode?.noise ?? 0.3,
      condition: locationNode?.condition ?? 100,
      // Use global temp from worldState or default to 20C
      temperature: matrix.worldState?.environment?.globalTemp ?? 20,
      // Support both property names common in these systems
      weather: matrix.worldState?.weather?.condition || matrix.worldState?.weather?.weather || 'Clear',
      light: getLightLevel(hour),
      crowding: matrix.locationAgentCount?.[agent.locationId] ?? 0
  };

  // 6. EXECUTE FSM TICK
  // This triggers State.tick(), which triggers BaseState.tick(), which applies Decay.
  // If the state is "Busy" (Sleeping, Working), it will remain in that state.
  const fsmResult = agent.fsm.tick(hour, localEnv, worldState);
  
  // FIX: Update status effects AFTER FSM tick (which handled the decay).
  // This ensures modifiers like "SICK" apply to the decay that just happened before duration decrements.
  if (typeof agent._updateStatusEffects === 'function') {
      agent._updateStatusEffects();
  }

  // FIX: Snapshot history only when an activity completes (transitions to idle).
  // This prevents noisy data points (e.g. recording hunger=-10 mid-meal).
  if (startState !== 'fsm_idle' && agent.state === 'fsm_idle') {
      if (typeof agent.updateHistory === 'function') {
          agent.updateHistory();
      }
  }
  
  let isDirty = fsmResult.isDirty;
  let walOp = fsmResult.walOp || null;

  // 7. CONSULT SCORER - REMOVED
  // The 'actionScorer' logic has been replaced by the IdleState Behavior Tree.
  // The FSM tick above (fsmResult) now handles all state transitions autonomously.

  // 8. IDLE THOUGHTS
  if (agent.lod === 1 && !isDirty && shouldLogThinking(agent, 'need')) {
    const stress = agent.stress ?? 0;
    const mood = agent.mood ?? 0;

    // FIX: Reduced spam probability from 0.02 to 0.005 (0.5%).
    // Prevents stressed agents from flooding the event log with complaints every few hours.
    if (Math.random() < 0.005) { 
        if (stress > 80) {
            matrix.eventBus.queue('log:agent', 'low', `[${agent.name}] I feel like I'm going to explode.`);
        } else if (mood < 10) {
            matrix.eventBus.queue('log:agent', 'low', `[${agent.name}] What's the point of all this?`);
        }
    }
  }

  return { isDirty, walOp };
}