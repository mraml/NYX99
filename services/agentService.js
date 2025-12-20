import {
  shouldLogThinking,
} from '../data/config.js';

import { getAgentGoal } from '../engine/actionScorer.js';

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
          environment: matrix.worldState?.environment 
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
  // calling it here caused 2x metabolism speed, leading to the death spiral.
  /* if (typeof agent._decayStats === 'function') {
      agent._decayStats(worldState);
  }
  */

  // 2. Sensory Processing
  if (typeof agent._processSenses === 'function') {
      agent._processSenses(worldState);
  }

  // 3. Status Effects (Buffs/Debuffs)
  // MOVED: To ensure multipliers apply to the current tick's decay, we update effects 
  // AFTER decay happens (in Transit block or after FSM tick).
  /* if (typeof agent._updateStatusEffects === 'function') {
      agent._updateStatusEffects();
  }
  */

  // 4. Memory Consolidation (Periodic)
  // MOVED: To end of Phase 2. We now only record history on "natural breakpoints"
  // (completion of activities) to avoid noisy data from mid-activity snapshots.
  /* if (matrix.tickCount % 100 === 0 && typeof agent.updateHistory === 'function') {
      agent.updateHistory();
  } */

  // 5. Movement Physics
  if (agent.inTransit || agent.travelTimer > 0) {
      if (typeof agent._handleMovement === 'function') {
          agent._handleMovement();
      }
      
      // FIX: Apply decay during transit. 
      // Since we skip FSM (where decay lives now), we must manually apply it here to prevent metabolic pausing.
      // This ensures 1x decay rate (consistent with the new 0.3 base in agent.js).
      if (typeof agent._decayStats === 'function') {
          agent._decayStats(worldState);
      }

      // FIX: Update status effects AFTER decay so multipliers apply for this tick.
      // If we did this before decay, a 1-tick remaining effect would expire before applying its modifier.
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
  // Previous version was missing temperature, light, and crowding, causing states
  // to fallback to defaults (always 20C, always empty) and ignore environmental stressors.
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

  // 7. CONSULT SCORER
  // FIX: Only run scorer if the agent is currently IDLE.
  // This enforces "State Commitment". If the agent is Sleeping, Working, or Eating,
  // we do NOT let the scorer override that decision until the FSM transitions them back to 'fsm_idle'.
  // This prevents agents from waking up at 80% energy just because a job score ticked up slightly.
  if (agent.state === 'fsm_idle') {
      try {
        const decision = getAgentGoal(agent, hour, matrix.locationAgentCount || {}, localEnv, null, worldState);
        
        if (decision && decision.goal) {
          if (agent.state !== decision.goal) {
            
            const transitionResult = agent.transitionToState(decision.goal);
            
            if (transitionResult.changed) {
                isDirty = true;
                if (transitionResult.walOp) walOp = transitionResult.walOp;

                // --- RICH LOGGING ---
                // FIX: Ensure critical events (Collapse/Break) are logged for ALL agents, not just LOD 1.
                // This is essential for diagnosing "Doom Loops" where background agents die silently.
                if (decision.reason === 'COLLAPSE' || decision.reason === 'MENTAL_BREAK') {
                    matrix.eventBus.queue('log:agent', 'high', `[${agent.name}] ${decision.detailedReason}`);
                    matrix.eventBus.queue('db:writeMemory', 'high', agent.id, matrix.tickCount, `Event: ${decision.detailedReason}`);
                } 
                else if (agent.lod === 1 && decision.detailedReason) {
                    const level = (decision.score > 1000) ? 'high' : 'low';
                    matrix.eventBus.queue('log:agent', level, `[${agent.name}] ${decision.detailedReason}`);
                }
            }
          }
        }
      } catch (err) {
        console.error(`[agentService] Scorer failed for ${agent.id}:`, err);
        // FIX: Force safe fallback to prevent stuck states if scorer crashes
        agent.transitionToState('fsm_idle');
        return { isDirty: true, walOp: null };
      }
  }

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