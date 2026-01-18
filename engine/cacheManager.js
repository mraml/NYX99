import Agent from './agent.js';
import crypto from 'crypto'; // Needed for ID repair
import { LOD2_TICK_INTERVAL } from '../data/config.js'; 
import worldGraph from '../data/worldGraph.js'; 
import { seedInitialRelationships } from './agentUtilities.js';
import logger from '../logger.js'; 

/**
 * cacheManager.js
 * (MODIFIED v13.0: Supports Optimized IPC Delta Updates)
 */
class CacheManager {
  constructor(eventBus, dbService, matrix) { 
    this.agents = new Map();
    this.dirtyAgents = new Set();
    this.matrix = matrix; 
    
    this.systemMetrics = {
        homeless: 0,
        unemployed: 0,
        sick: 0,
        totalWealth: 0,
        avgMood: 0,
        topJob: 'None'
    };
    this.lastMetricsTick = -1;
  }

  // Helper to ensure agent data is clean before hydration
  _sanitizeAgentData(data) {
      if (!data) return null;
      if (typeof data.id === 'object') {
          logger.warn(`[CacheManager] Found corrupted agent ID object. Regenerating.`);
          data.id = crypto.randomUUID();
      }
      if (!Array.isArray(data.inventory)) data.inventory = [];
      if (!data.history || Array.isArray(data.history) || typeof data.history !== 'object') {
          data.history = { mood: [], energy: [], stress: [], money: [] };
      }
      return data;
  }

  _coerceAgentData(agentData) {
    const coerced = { ...agentData };
    
    // JSON Fields that might be strings in DB but objects in Memory
    const JSON_FIELDS = [
        'persona', 'job', 'interests', 'inventory', 'status_effects', 
        'relationships', 'skills', 'aspiration', 'recentActivities', 
        'routines', 'contextualRoutines', 'intentionStack', 'beliefs', 
        'intentionPlan', 'perceivedAgents', 'history'
    ];

    for (const field of JSON_FIELDS) {
        if (typeof coerced[field] === 'string') {
            try {
                coerced[field] = JSON.parse(coerced[field]);
            } catch (e) {
                if (['inventory','recentActivities','routines','contextualRoutines','intentionStack','intentionPlan','perceivedAgents','status_effects'].includes(field)) {
                    coerced[field] = [];
                } else {
                    coerced[field] = {};
                }
            }
        }
    }
    return coerced;
  }

  addAgent(agent) {
    if (!agent || !agent.id) return;
    this.agents.set(agent.id, agent);
    this.dirtyAgents.add(agent.id);
  }

  getAgent(id) {
    return this.agents.get(id);
  }

  getAllAgents() {
    return Array.from(this.agents.values());
  }
  
  getAllAgentIds() {
      return Array.from(this.agents.keys());
  }

  getDirtyAgents() {
    const dirty = [];
    for (const id of this.dirtyAgents) {
      const agent = this.agents.get(id);
      if (agent) dirty.push(agent);
    }
    this.dirtyAgents.clear();
    return dirty;
  }
  
  markAgentDirty(agentId) {
      if (this.agents.has(agentId)) {
          this.dirtyAgents.add(agentId);
      }
  }

  loadFromCheckpoint(baseState) {
    this.agents.clear();
    const agentsData = baseState.agents || [];
    const hydratedAgents = [];

    logger.info(`[CacheManager] Hydrating ${agentsData.length} agents from checkpoint...`);

    for (const agentData of agentsData) {
      try {
        const cleanData = this._sanitizeAgentData(agentData);
        const coercedData = this._coerceAgentData(cleanData);
        const agent = new Agent(coercedData);
        agent.matrix = this.matrix;
        this.agents.set(agent.id, agent);
        hydratedAgents.push(agent);
      } catch (err) {
        logger.error(`[CacheManager] Failed to hydrate agent ${agentData?.id}: ${err.message}`);
      }
    }
    this.getSystemMetrics(hydratedAgents);
    return hydratedAgents;
  }
  
  applyWAL(walEntries) {
    if (!walEntries || walEntries.length === 0) return;
    logger.info(`[CacheManager] Replaying ${walEntries.length} events...`);
    for (const entry of walEntries) {
      if (!entry.data) continue;
      let data;
      try {
          data = typeof entry.data === 'string' ? JSON.parse(entry.data) : entry.data;
      } catch (e) { continue; }

      const agent = this.getAgent(data.agentId);
      if (!agent) continue;

      switch (entry.op) {
        case 'AGENT_STATE_CHANGE':
          if (data.newState) agent.state = data.newState;
          break;
        case 'AGENT_LOCATION_CHANGE':
          if (data.newLocation) agent.locationId = data.newLocation;
          break;
        case 'AGENT_UPDATE_STATS':
          if (data.stats) {
              if (data.stats.hunger !== undefined) agent.hunger = data.stats.hunger;
              if (data.stats.energy !== undefined) agent.energy = data.stats.energy;
              if (data.stats.money !== undefined) agent.money = data.stats.money;
          }
          break;
      }
      this.markAgentDirty(agent.id);
    }
  }

  createNewAgents(count, currentTick) {
    const newAgents = [];
    logger.info(`[CacheManager] Creating ${count} new agents...`);
    
    // 1. Primary Search: Explicit 'home' types
    let availableHomes = Object.values(worldGraph.nodes).filter(n => n.type === 'home');
    
    // 2. Secondary Search: Residential keywords
    if (availableHomes.length === 0) {
        availableHomes = Object.values(worldGraph.nodes).filter(n => 
            ['apartment', 'condo', 'residential', 'house'].includes(n.type)
        );
    }
    
    // 3. Fallback: Any node (Prevents infinite homeless loops)
    if (availableHomes.length === 0) {
        logger.warn('[CacheManager] CRITICAL: No housing nodes found! Assigning random locations as homes to prevent homelessness loop.');
        availableHomes = Object.values(worldGraph.nodes);
    }
    
    for (let i = 0; i < count; i++) {
      const agent = new Agent({ activityStartTick: currentTick });
      agent.matrix = this.matrix;
      agent.state = 'fsm_idle';
      
      // ASSIGN HOME AT SPAWN
      if (availableHomes.length > 0) {
        const homeNode = availableHomes[Math.floor(Math.random() * availableHomes.length)];
        agent.homeLocationId = homeNode.key;
        // [FIX] REMOVED agent.homeNode = homeNode;
        // Storing the object reference caused stale data issues when worldGraph mutated.
        // We now rely solely on homeLocationId as the single source of truth.
        
        agent.locationId = homeNode.key; // Start at home
        agent.rent_cost = homeNode.rent_cost || 1200;
        
        // Ensure they have enough initial money for at least one rent payment + expenses
        if ((agent.money || 0) < agent.rent_cost) {
            agent.money = agent.rent_cost + 500;
        }
        
        // LOGGING: Verify home assignment
        if (i < 5) { // Only log first 5 to avoid spam
             logger.info(`[CacheManager] Created agent ${agent.name} with home ${agent.homeLocationId}`);
        }
      } else {
          logger.error(`[CacheManager] FAILED to assign home to agent ${agent.name}`);
      }
      
      this.addAgent(agent);
      newAgents.push(agent);
    }
    
    this.runPostInitSetup(newAgents);
    return newAgents;
  }
  
  runPostInitSetup(agentsToSetup) {
    this.seedAllRelationships(agentsToSetup);
    for (const agent of agentsToSetup) {
      if (agent.fsm && typeof agent.fsm.startInitialState === 'function') {
          agent.fsm.startInitialState(); 
      }
    }
  }
  
  seedAllRelationships(agentsToSeed) {
    if (typeof seedInitialRelationships === 'function') {
        logger.info('[CacheManager] Seeding initial relationships...');
        const allIds = this.getAllAgentIds();
        for (const agent of agentsToSeed) {
            if (Object.keys(agent.relationships).length === 0) {
                agent.relationships = seedInitialRelationships(agent, allIds);
                this.dirtyAgents.add(agent.id); 
            }
        }
    }
  }

  getSystemMetrics(agentsOverride = null) {
      if (this.matrix && this.matrix.tickCount === this.lastMetricsTick) {
          return this.systemMetrics;
      }
      const agents = agentsOverride || this.getAllAgents();
      if (agents.length === 0) return this.systemMetrics;

      let homeless = 0, unemployed = 0, sick = 0, totalWealth = 0, totalMood = 0;
      const jobs = {};

      for (const a of agents) {
          if (a.state === 'fsm_homeless') homeless++;
          if (!a.job || !a.job.title || a.job.title === 'Unemployed') unemployed++;
          if ((a.status_effects || []).some(e => e.type === 'SICK')) sick++;
          totalWealth += (a.money || 0);
          totalMood += (a.mood || 0);
          if (a.job && a.job.title) jobs[a.job.title] = (jobs[a.job.title] || 0) + 1;
      }

      const topJobEntry = Object.entries(jobs).sort((a, b) => b[1] - a[1])[0];
      this.systemMetrics = {
          homeless, unemployed, sick, totalWealth,
          avgMood: totalMood / agents.length,
          topJob: topJobEntry ? `${topJobEntry[0]} (${topJobEntry[1]})` : 'None'
      };
      if (this.matrix) this.lastMetricsTick = this.matrix.tickCount;
      return this.systemMetrics;
  }
  
  // --- CRITICAL FIX: Enhanced Merge ---
  mergeAgentUpdates(updatedAgentsData) {
      for (const data of updatedAgentsData) {
          const agent = this.agents.get(data.id);
          if (agent) {
              // 1. Sync Scalars
              agent.state = data.state;
              agent.locationId = data.locationId;
              agent.money = data.money;
              agent.hunger = data.hunger;
              agent.energy = data.energy;
              agent.social = data.social;
              agent.mood = data.mood;
              agent.stress = data.stress;
              agent.currentActivityName = data.currentActivityName; 
              
              // 1b. Sync Housing (Persistence Fix)
              // Only overwrite if the update explicitly contains data
              if (data.homeLocationId !== undefined) {
                  agent.homeLocationId = data.homeLocationId;
              }
              if (data.rent_cost !== undefined) agent.rent_cost = data.rent_cost;

              // 2. Sync Complex Objects (Arrays/Maps)
              // We now receive these as raw objects via IPC, no parsing needed.
              // FIX: Sync empty arrays/nulls if explicitly sent (handles cleared inventory/state)
              if (data.inventory !== undefined) agent.inventory = data.inventory;
              if (data.status_effects !== undefined) agent.status_effects = data.status_effects;
              if (data.recentActivities !== undefined) agent.recentActivities = data.recentActivities;
              if (data.relationships !== undefined) agent.relationships = data.relationships;
              if (data.history !== undefined) agent.history = data.history;
              if (data.intentionStack !== undefined) agent.intentionStack = data.intentionStack;
              
              // FIX: Sync Job Data to prevent "Unemployed" drift in UI
              if (data.job !== undefined) agent.job = data.job;
              
              this.dirtyAgents.add(agent.id);
          }
      }
  }
  
  getFullState() {
      return {
          agents: this.getAllAgents().map(a => a.serialize())
      };
  }
  
  getOccupancyMap() {
      const map = new Map();
      for (const agent of this.agents.values()) {
          const loc = agent.locationId;
          if (loc) {
              map.set(loc, (map.get(loc) || 0) + 1);
          }
      }
      return map;
  }
}

export default CacheManager;