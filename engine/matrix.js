import {
  TICK_RATE_MS,
  MINUTES_PER_TICK,
  SYNC_INTERVAL_TICKS,
  CHECKPOINT_INTERVAL_TICKS,
  DB_PATH,
  INITIAL_AGENTS,
} from '../data/config.js';

import { Worker } from 'worker_threads';
import path from 'path';
import os from 'os';

import DbService from '../dbService.js';
import CacheManager from './cacheManager.js';
import Dashboard from '../ui/dashboard.js';
import eventBus from './eventBus.js';
import { dataLoader } from '../data/dataLoader.js';
// FIX: Change named import to default import to match worldGraph.js export change
import worldGraph from '../data/worldGraph.js';
import { FiniteStateMachine } from './fsm.js';
import { worldPartitioner } from './worldPartitioner.js';
import { hydrateWorldGraph } from './worldSeeder.js';
import logger from '../logger.js';
import { initWorldService, updateWorldState } from '../services/worldService.js';

// --- CONFIGURATION ---
const isHeadless = process.argv.includes('--headless');
const NUM_WORKERS = Math.max(1, os.cpus().length - 1);
const __dirname = path.resolve(path.dirname(''));
const WORKER_TIMEOUT_MS = 10000;
const REBALANCE_INTERVAL_TICKS = 100; // Rebalance worker partitions every N ticks
const MAX_WORKER_FAILURES = 3;        // Max failures before circuit breaker trips
const FAILURE_WINDOW_MS = 60000;      // Time window for failure counting (1 min)

// Adaptive Pacing Configuration
const ADAPTIVE_PACING = {
  LAG_THRESHOLD: 10,       // Consecutive slow ticks before throttling down
  RECOVERY_THRESHOLD: 20,  // Consecutive fast ticks before speeding up
  THROTTLE_STEP: 50,       // Ms to add/remove per adjustment step
  MAX_TICK_RATE: 2000,     // Max slowness (2 seconds per tick)
  BASE_RATE: TICK_RATE_MS
};

class SimulationError extends Error {
  constructor(message, context) {
    super(message);
    this.name = 'SimulationError';
    this.context = context;
    this.tick = global.currentTick;
    this.stackSnapshot = this._captureSimulationState();
  }

  _captureSimulationState() {
    return {
      activeAgentCount: global.cacheManager?.getAllAgents().length,
      memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    };
  }
}
global.SimulationError = SimulationError;

function dumpError(err, context = {}) {
  if (global.dashboard && typeof global.dashboard.emergencyShutdown === 'function') {
    try { global.dashboard.emergencyShutdown(); } catch (e) { }
  }
  console.error(`\n!!! CRITICAL UNCAUGHT EXCEPTION !!!`);
  if (context) console.error('Context:', JSON.stringify(context, null, 2));
  console.error(err.stack || err);
  process.exit(1);
}

class Matrix {
  constructor() {
    logger.info('[Matrix] Constructor called');
    this.tickCount = 0;
    this.worldTime = new Date('1999-01-01T08:00:00');
    this.isRunning = false;
    this.isTickInProgress = false; // Track active tick state
    this.isInitialized = false;    // Track initialization state
    this.isDbSyncing = false;      // Track active DB synchronization

    this.worldState = {
      weather: { weather: 'Clear', mood: 'neutral' },
      timeOfDay: 'morning',
      economy: 'Stable',
      environment: { globalLight: 0.8, globalTemp: 20 },
      locationSocialContext: new Map(),
      world_events: [],
    };

    // Initialize references to null/defaults (No side effects in constructor)
    this.eventBus = null;
    this.dbService = null;
    this.cacheManager = null;
    this.dashboard = null;
    
    this.workerPool = new Map();
    // Track worker health: 'initializing', 'healthy', 'hanging', 'dead', 'dead_processed', 'circuit_open'
    this.workerHealth = new Map(); 
    this.workerFailureHistory = new Map(); // Track timestamps of failures per worker

    this.agentWorkerMap = new Map();
    this.workerAgentLoads = new Map();
    this.workerTickPromises = new Map();
    this.partitionMap = new Map();
    this.workerLocationMap = new Map();
    this.locationAgentCount = new Map(); // Track agent density for load balancing
    
    // Copy-On-Write Graph Snapshot State
    this.graphSnapshot = null;
    this.graphVersion = 0;
    
    // Adaptive Pacing State
    this.targetTickRate = TICK_RATE_MS;
    this.lagStreak = 0;
    this.recoveryStreak = 0;
    
    this.initPromise = null;
  }

  async _spawnWorker(workerId) {
    this.workerHealth.set(workerId, 'initializing');

    // Defensive cleanup: If we are spawning over an existing slot, ensure the old one is gone.
    if (this.workerPool.has(workerId)) {
        const existing = this.workerPool.get(workerId);
        existing.removeAllListeners();
        // Force terminate if it hasn't exited yet
        try { existing.terminate(); } catch (e) {}
    }

    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'workers/agent.worker.js'));
      worker.on('message', (msg) => this._handleWorkerMessage(workerId, msg, resolve, reject));
      worker.on('error', (err) => this._handleWorkerError(workerId, err));
      
      // Capture the specific worker instance to ensure we clean up the correct one on exit
      worker.on('exit', (code) => this._handleWorkerExit(workerId, code, worker));
      
      this.workerPool.set(workerId, worker);
      
      const locationsForWorker = Array.from(this.workerLocationMap.get(workerId) || new Set());

      // FAIL FAST: Validate partition integrity against current world state
      // Ensure we have a snapshot to validate against (handles edge case of early spawn)
      if (!this.graphSnapshot) {
          this.graphSnapshot = this._createGraphSnapshot();
      }

      // Check if assigned locations actually exist in the graph
      const invalidLocations = locationsForWorker.filter(locId => !this.graphSnapshot.nodes[locId]);
      if (invalidLocations.length > 0) {
          const err = new Error(`Worker ${workerId} Init Failed: Partition contains invalid locations: [${invalidLocations.join(', ')}]`);
          logger.error(`[Matrix] ${err.message}`);
          
          // Reject init immediately to prevent zombie worker
          reject(err);
          
          // Terminate the worker since it cannot function with an invalid partition
          worker.terminate();
          return;
      }
      
      worker.postMessage({ 
        type: 'INIT', 
        payload: { 
            partition: { workerId, locations: locationsForWorker },
            graph: this.graphSnapshot // Send immutable graph snapshot for worker-side validation/pathfinding
        } 
      });
    });
  }

  _handleWorkerMessage(workerId, msg, resolveInit, rejectInit) {
    switch (msg.type) {
      case 'INIT_COMPLETE':
        this.workerHealth.set(workerId, 'healthy');
        if (resolveInit) resolveInit(this.workerPool.get(workerId));
        break;
      case 'INIT_FAILED':
        this.workerHealth.set(workerId, 'dead');
        if (rejectInit) rejectInit(new Error(msg.error));
        break;
      case 'TICK_COMPLETE':
        const tickResolver = this.workerTickPromises.get(workerId);
        if (tickResolver) {
          tickResolver(msg);
          this.workerTickPromises.delete(workerId);
        }
        break;
    }
  }

  async _handleWorkerError(workerId, err) {
    logger.error(`[Matrix] Worker ${workerId} error:`, err);
  }

  async _handleWorkerExit(workerId, code, deadWorker) {
    // Explicitly remove listeners to prevent memory leaks and ghost events
    if (deadWorker) {
        deadWorker.removeAllListeners();
    }

    this.workerHealth.set(workerId, 'dead'); 

    if (!this.isRunning) return; 

    // DEFERRED RESPAWN: If a tick is in progress, do not respawn immediately.
    // The tick loop will detect the failure via Promise rejection/timeout,
    // redistribute the load, and then trigger the respawn in a controlled manner.
    if (this.isTickInProgress) {
        logger.warn(`[Matrix] Worker ${workerId} exited during tick. Deferring respawn.`);
        return;
    }
    
    // code 1 usually means terminated or error, 0 is clean exit.
    if (code !== 0) {
      // CIRCUIT BREAKER CHECK
      if (!this._checkCircuitBreaker(workerId)) {
          this._handlePermanentWorkerLoss(workerId); // Ensure load is completely offloaded
          this.workerHealth.set(workerId, 'circuit_open');
          return;
      }

      logger.warn(`[Matrix] Worker ${workerId} exited unexpectedly (code ${code}). Respawning...`);
      try {
        await new Promise(r => setTimeout(r, 1000)); 
        await this._spawnWorker(workerId);
      } catch (e) {
        logger.error(`[Matrix] Failed to respawn worker ${workerId}. Redistributing load.`, e);
        try {
          // Robustness: If respawn fails, redistribute agents to surviving workers
          this._handlePermanentWorkerLoss(workerId);
        } catch (fatalError) {
          // If redistribution fails (e.g., no healthy workers left), then we crash
          dumpError(fatalError, { code, workerId });
        }
      }
    }
  }

  // Returns true if safe to respawn, false if circuit tripped
  _checkCircuitBreaker(workerId) {
    const now = Date.now();
    let history = this.workerFailureHistory.get(workerId) || [];
    
    // Filter failures within the window
    history = history.filter(t => now - t < FAILURE_WINDOW_MS);
    
    // Record this failure
    history.push(now);
    this.workerFailureHistory.set(workerId, history);

    if (history.length >= MAX_WORKER_FAILURES) {
        logger.error(`[Matrix] CIRCUIT BREAKER TRIPPED for Worker ${workerId}. ${history.length} failures in ${FAILURE_WINDOW_MS/1000}s.`);
        return false;
    }
    return true;
  }

  _handlePermanentWorkerLoss(deadWorkerId) {
    // Idempotency check
    if (this.workerHealth.get(deadWorkerId) === 'dead_processed') return;
    
    logger.warn(`[Matrix] Processing permanent loss of Worker ${deadWorkerId}`);
    this.workerHealth.set(deadWorkerId, 'dead_processed');

    // Find a healthy target worker
    const healthyIds = Array.from(this.workerPool.keys()).filter(id => 
        id !== deadWorkerId && 
        this.workerHealth.get(id) === 'healthy'
    );

    if (healthyIds.length === 0) {
        throw new Error('System Collapse: No healthy workers available for redistribution.');
    }

    // Pick a target (could be load-balanced, here we pick first available)
    const targetWorkerId = healthyIds[0];
    logger.info(`[Matrix] Redistributing load: Worker ${deadWorkerId} -> Worker ${targetWorkerId}`);

    // 1. Reassign Partitions (Location Ownership)
    for (const [locId, wId] of this.partitionMap.entries()) {
        if (wId === deadWorkerId) this.partitionMap.set(locId, targetWorkerId);
    }

    // 2. Reassign Agents (Move active load)
    const deadLoad = this.workerAgentLoads.get(deadWorkerId);
    const targetLoad = this.workerAgentLoads.get(targetWorkerId);

    if (deadLoad && deadLoad.size > 0 && targetLoad) {
        for (const agentId of deadLoad) {
            this.agentWorkerMap.set(agentId, targetWorkerId);
            targetLoad.add(agentId);
        }
        deadLoad.clear();
    }

    // 3. Cleanup Resources
    if (this.workerPool.has(deadWorkerId)) {
        const deadWorker = this.workerPool.get(deadWorkerId);
        deadWorker.removeAllListeners();
        try { deadWorker.terminate(); } catch(e) {}
        this.workerPool.delete(deadWorkerId);
    }
    this.workerTickPromises.delete(deadWorkerId);
  }

  _validateWorkerResult(workerId, data) {
    if (!data || typeof data !== 'object') {
        logger.error(`[Matrix] Validation Failed: Worker ${workerId} sent non-object payload.`);
        return false;
    }

    // Validate updatedAgents
    if (data.updatedAgents !== undefined) {
        if (!Array.isArray(data.updatedAgents)) {
            logger.error(`[Matrix] Validation Failed: Worker ${workerId} updatedAgents is not an array.`);
            return false;
        }
        for (const agent of data.updatedAgents) {
            if (!agent || (typeof agent.id !== 'string' && typeof agent.id !== 'number')) {
                logger.error(`[Matrix] Validation Failed: Worker ${workerId} sent malformed agent (missing/invalid ID).`);
                return false;
            }
        }
    }

    // Validate walOps
    if (data.walOps !== undefined && !Array.isArray(data.walOps)) {
        logger.error(`[Matrix] Validation Failed: Worker ${workerId} walOps is not an array.`);
        return false;
    }

    // Validate logEvents
    if (data.logEvents !== undefined && !Array.isArray(data.logEvents)) {
        logger.error(`[Matrix] Validation Failed: Worker ${workerId} logEvents is not an array.`);
        return false;
    }

    return true;
  }

  async _initWorkerPool() {
    logger.info(`[Matrix] Initializing pool with ${NUM_WORKERS} workers...`);
    const { partitionMap, workerLocationMap } = worldPartitioner.partitionWorld(NUM_WORKERS);
    this.partitionMap = partitionMap;
    this.workerLocationMap = workerLocationMap;
    
    this.workerAgentLoads = new Map();
    for (let i = 0; i < NUM_WORKERS; i++) this.workerAgentLoads.set(i, new Set());
    
    const promises = [];
    for (let i = 0; i < NUM_WORKERS; i++) promises.push(this._spawnWorker(i));
    
    // NEW: Use allSettled to allow partial startup
    const results = await Promise.allSettled(promises);
    
    const successCount = results.filter(r => r.status === 'fulfilled').length;
    // Require at least 50% of workers or 1, whichever is higher
    const MIN_WORKERS = Math.max(1, Math.floor(NUM_WORKERS * 0.5));

    if (successCount < MIN_WORKERS) {
        throw new Error(`Critical Worker Failure: Only ${successCount}/${NUM_WORKERS} initialized. Required: ${MIN_WORKERS}`);
    }

    // Handle initial failures gracefully
    for (let i = 0; i < NUM_WORKERS; i++) {
        if (results[i].status === 'rejected') {
            logger.error(`[Matrix] Worker ${i} failed init: ${results[i].reason}`);
            // Redistribute this worker's partitions immediately
            this._handlePermanentWorkerLoss(i);
        }
    }
    
    logger.info(`[Matrix] Worker pool initialization complete. Active: ${successCount}/${NUM_WORKERS}`);
  }

  _distributeAgentsToWorkers(agents) {
    // Reset loads - careful to only reset for existing keys if we are post-init failure
    for (let i = 0; i < NUM_WORKERS; i++) {
        if (this.workerAgentLoads.has(i)) this.workerAgentLoads.get(i).clear();
    }
    this.agentWorkerMap.clear();
    
    const validWorkerIds = Array.from(this.workerPool.keys());
    
    agents.forEach(agent => {
      // FIX: Use current location primarily for correct distribution during mid-simulation load
      const locationKey = agent.locationId || agent.homeLocationId;
      let workerId = this.partitionMap.get(locationKey);
      
      // Fallback if partition points to a dead/missing worker
      if (workerId === undefined || !this.workerAgentLoads.has(workerId)) {
           // Assign to first valid worker as fallback
           workerId = validWorkerIds.length > 0 ? validWorkerIds[0] : 0;
      }
      
      // Ensure the set exists before adding (defensive)
      if (this.workerAgentLoads.has(workerId)) {
        this.workerAgentLoads.get(workerId).add(agent.id);
        this.agentWorkerMap.set(agent.id, workerId);
      }
    });
    
    logger.info(`[Matrix] Distributed ${agents.length} agents across ${validWorkerIds.length} active workers.`);
  }

  async init() {
    // IDEMPOTENCY CHECK: Return existing promise if running, or return if done
    if (this.isInitialized) {
        logger.info('[Matrix] Already initialized.');
        return;
    }
    if (this.initPromise) {
        return this.initPromise;
    }

    this.initPromise = (async () => {
      try {
        logger.info('[Matrix] Initializing...');

        // 1. Setup Globals and Event Bus
        this.eventBus = eventBus;
        global.eventBus = eventBus;

        // 2. Initialize Services (Explicit Order)
        this.dbService = new DbService(DB_PATH);
        await this.dbService.init();

        this.cacheManager = new CacheManager(this.eventBus, this.dbService, this);
        global.cacheManager = this.cacheManager;

        if (!isHeadless) {
          this.dashboard = new Dashboard(this.dbService);
          this.dashboard.setDbService(this.dbService);
          this.dashboard.setCacheManager(this.cacheManager);
          global.dashboard = this.dashboard;
        }

        // 3. Load Simulation Data & State
        await this._loadSimulationState();

        this.isInitialized = true;
        logger.info('[Matrix] Initialization complete.');
      } catch (err) {
        logger.error('[Matrix] Initialization failed:', err);
        // Reset promise to allow retries
        this.initPromise = null;
        
        // Cleanup partial state if necessary
        if (this.dbService) {
            this.dbService = null;
        }
        // Force cleanup of any workers that might have started
        this.workerPool.forEach(w => {
            try { w.terminate(); } catch(e){}
        });
        this.workerPool.clear();

        throw err;
      }
    })();

    return this.initPromise;
  }

  // Helper to create a thread-safe snapshot of the world graph
  _createGraphSnapshot() {
    try {
        // Use structuredClone if available for deep copy efficiency
        // FIX: Include EDGES in snapshot so workers can navigate
        const snapshot = {
            nodes: typeof structuredClone === 'function' ? structuredClone(worldGraph.nodes) : JSON.parse(JSON.stringify(worldGraph.nodes)),
            edges: typeof structuredClone === 'function' ? structuredClone(worldGraph.edges) : JSON.parse(JSON.stringify(worldGraph.edges)),
            version: ++this.graphVersion
        };
        return snapshot;
    } catch (e) {
        // Fallback for circular refs or errors
        logger.warn('[Matrix] Graph snapshot failed, using fallback copy.');
        return {
            nodes: JSON.parse(JSON.stringify(worldGraph.nodes)),
            edges: JSON.parse(JSON.stringify(worldGraph.edges)),
            version: ++this.graphVersion
        };
    }
  }

  async _loadSimulationState() {
    logger.info('[Matrix] Loading Simulation Data...');
    
    // 1. Load YAML data
    logger.info('[Matrix] Step 1: Loading YAML data via dataLoader...');
    await dataLoader.loadAllData();
    
    // VALIDATION: Check if critical data loaded
    if (!dataLoader.locationGraph || !dataLoader.locationGraph.nodes) {
        throw new Error('CRITICAL: location_graph.yaml failed to load or is malformed.');
    }
    if (!dataLoader.locationGraph.edges) {
        throw new Error('CRITICAL: location_graph.yaml missing edges array.');
    }
    logger.info(`[Matrix] ✓ Loaded ${dataLoader.locationGraph.nodes.length} nodes and ${dataLoader.locationGraph.edges.length} edges.`);
    
    // 2. Initialize worldGraph
    logger.info('[Matrix] Step 2: Initializing worldGraph...');
    worldGraph.init();
    
    const nodeCount = Object.keys(worldGraph.nodes).length;
    if (nodeCount === 0) {
        throw new Error('CRITICAL: worldGraph.init() completed but no nodes were loaded.');
    }
    logger.info(`[Matrix] ✓ worldGraph initialized with ${nodeCount} nodes.`);
    
    // 3. Hydrate and prepare world
    logger.info('[Matrix] Step 3: Hydrating world graph...');
    hydrateWorldGraph(worldGraph);
    logger.info('[Matrix] ✓ World graph hydrated.');
    
    logger.info('[Matrix] Step 4: Initializing world service...');
    initWorldService();
    logger.info('[Matrix] ✓ World service initialized.');
    
    logger.info('[Matrix] Step 5: Precomputing affordance cache...');
    this._precomputeAffordanceCache();
    logger.info('[Matrix] ✓ Affordance cache ready.');
    
    // 4. Create initial graph snapshot
    logger.info('[Matrix] Step 6: Creating graph snapshot for workers...');
    this.graphSnapshot = this._createGraphSnapshot();
    logger.info(`[Matrix] ✓ Graph snapshot created (version ${this.graphVersion}).`);
    
    // 5. Set player focus
    if (Object.keys(worldGraph.nodes).length > 0) {
        this.playerFocus = Object.keys(worldGraph.nodes)[0];
        logger.info(`[Matrix] ✓ Player focus set to: ${this.playerFocus}`);
    }

    // 6. Initialize worker pool BEFORE loading agents
    logger.info('[Matrix] Step 7: Initializing worker pool...');
    await this._initWorkerPool();
    logger.info(`[Matrix] ✓ Worker pool ready (${this.workerPool.size} workers active).`);

    // 7. Load recovery state from DB
    logger.info('[Matrix] Step 8: Loading state from database...');
    const { baseState, lastTick } = await this.dbService.loadStateFromRecovery();
    this.tickCount = lastTick || 0;
    logger.info(`[Matrix] ✓ Loaded DB state. Last tick: ${this.tickCount}`);

    // 8. Calculate world time
    const baseTime = new Date('1999-01-01T08:00:00').getTime();
    this.worldTime = new Date(baseTime + (this.tickCount * MINUTES_PER_TICK * 60000));
    logger.info(`[Matrix] ✓ World time set to: ${this.worldTime.toISOString()}`);

    // 9. Load or Create Agents - WITH DETAILED LOGGING
    logger.info('[Matrix] Step 9: Loading agents from checkpoint...');
    let agents = await this.cacheManager.loadFromCheckpoint(baseState);
    logger.info(`[Matrix] Checkpoint returned ${agents.length} agents.`);
    
    if (agents.length === 0) {
        logger.info(`[Matrix] No agents in DB. Creating ${INITIAL_AGENTS} new agents...`);
        
        try {
            await this.cacheManager.createNewAgents(INITIAL_AGENTS, this.tickCount);
            logger.info('[Matrix] ✓ createNewAgents() completed.');
            
            // Reload agents after creation
            agents = this.cacheManager.getAllAgents();
            logger.info(`[Matrix] After creation, getAllAgents() returned ${agents.length} agents.`);
            
            if (agents.length === 0) {
                throw new Error('CRITICAL: createNewAgents succeeded but getAllAgents returns 0. CacheManager state corrupted.');
            }
        } catch (err) {
            logger.error(`[Matrix] FAILED to create agents: ${err.message}`);
            logger.error(`[Matrix] Stack: ${err.stack}`);
            throw err;
        }
    }

    // 10. Assign matrix reference to all agents
    logger.info('[Matrix] Step 10: Assigning matrix references...');
    agents.forEach(agent => { agent.matrix = this; });
    logger.info(`[Matrix] ✓ Matrix assigned to ${agents.length} agents.`);
    
    // 11. Populate employees
    logger.info('[Matrix] Step 11: Populating business employees...');
    this._populateEmployees(agents);
    logger.info('[Matrix] ✓ Employees populated.');

    // 12. Distribute agents to workers
    logger.info('[Matrix] Step 12: Distributing agents to workers...');
    this._distributeAgentsToWorkers(agents);
    logger.info('[Matrix] ✓ Agent distribution complete.');

    logger.info(`[Matrix] ===== STATE LOAD COMPLETE =====`);
    logger.info(`[Matrix] Agents: ${agents.length} | Tick: ${this.tickCount} | Workers: ${this.workerPool.size}`);
  }

  _precomputeAffordanceCache() {
    worldGraph.affordanceCache = {};
    const affordancesToCache = ['fsm_shopping', 'fsm_eating', 'fsm_socializing', 'fsm_recreation'];
    for (const name of affordancesToCache) worldGraph.affordanceCache[name] = {};
  }

  _populateEmployees(allAgents) {
    for (const agent of allAgents) {
      if (agent.workLocationId) {
        const n = worldGraph.nodes[agent.workLocationId];
        if (n?.is_business) n.employee_ids.push(agent.id);
      }
    }
  }

  async start() {
    logger.info('[Matrix] start() called');
    try {
      // Auto-initialize if necessary to prevent startup crashes (Fixes crash in index.js)
      if (!this.isInitialized) {
        logger.warn('[Matrix] start() called without explicit init(). Auto-initializing...');
        await this.init();
      }

      if (this.workerPool.size === 0) {
        throw new Error('Worker pool failed to initialize.');
      }

      this.isRunning = true;
      this._runLoop(); 

    } catch (err) {
      dumpError(err, { phase: 'Pre-Flight Validation' });
    }
  }

  async _runLoop() {
    logger.info('[Matrix] Game Loop Started');
    
    while (this.isRunning) {
      const loopStart = Date.now();
      
      // DB HEALTH CHECK & RECOVERY
      // P1 FIX: Simplified health check logic using the boolean property `isHealthy`
      if (this.dbService && !this.dbService.isHealthy) {
          logger.error('[Matrix] CRITICAL: Database reported unhealthy. Pausing simulation...');
          
          try {
              // Attempt reconnection strategy via init()
              logger.info('[Matrix] Attempting DB reconnection...');
              await this.dbService.init(); 
              
              if (!this.dbService.isHealthy) { 
                  throw new Error('Reconnection attempt failed');
              }
              logger.info('[Matrix] DB Reconnected. Resuming simulation.');
          } catch (err) {
              logger.error(`[Matrix] DB Recovery failed: ${err.message}. Retrying in 5s...`);
              await new Promise(resolve => setTimeout(resolve, 5000));
              continue; // Skip this tick, wait for recovery
          }
      }

      try {
        await this.tick();
      } catch (err) {
        logger.error('[MATRIX] Tick Error:', err);
        this.eventBus.emitNow('system:error', { error: err.message, tick: this.tickCount });
      }

      const elapsed = Date.now() - loopStart;
      
      // --- ADAPTIVE PACING LOGIC ---
      if (elapsed > this.targetTickRate) {
          this.lagStreak++;
          this.recoveryStreak = 0;
          
          // Throttling Logic: Slow down if lag persists
          if (this.lagStreak >= ADAPTIVE_PACING.LAG_THRESHOLD) {
              if (this.targetTickRate < ADAPTIVE_PACING.MAX_TICK_RATE) {
                  this.targetTickRate = Math.min(
                      this.targetTickRate + ADAPTIVE_PACING.THROTTLE_STEP, 
                      ADAPTIVE_PACING.MAX_TICK_RATE
                  );
                  // Reset streak to allow stabilization at new rate before throttling again
                  this.lagStreak = 0; 
                  logger.warn(`[Matrix] System Overload Detected. Throttling simulation speed to ${this.targetTickRate}ms.`);
              }
          }
          
          if (this.lagStreak > 0) {
             logger.warn(`[Matrix] Tick Lag! Took ${elapsed}ms (Target: ${this.targetTickRate}ms)`);
          }
      } else {
          this.recoveryStreak++;
          this.lagStreak = 0;
          
          // Recovery Logic: Speed up if system is healthy and was previously throttled
          if (this.targetTickRate > ADAPTIVE_PACING.BASE_RATE && 
              this.recoveryStreak >= ADAPTIVE_PACING.RECOVERY_THRESHOLD) {
              
              this.targetTickRate = Math.max(
                  this.targetTickRate - ADAPTIVE_PACING.THROTTLE_STEP, 
                  ADAPTIVE_PACING.BASE_RATE
              );
              this.recoveryStreak = 0; // Reset streak
              logger.info(`[Matrix] System Stabilized. Increasing simulation speed to ${this.targetTickRate}ms.`);
          }
      }

      // Calculate delay based on the DYNAMIC target rate
      const delay = Math.max(0, this.targetTickRate - elapsed);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  async stop() {
    logger.info('[Matrix] Initiating graceful shutdown...');
    this.isRunning = false;

    // Safety timeout: If shutdown hangs for >30s, force exit
    const shutdownTimer = setTimeout(() => {
        logger.error('[Matrix] Shutdown timed out! Forcing exit.');
        process.exit(1);
    }, 30000);

    // Drain: Wait for the current tick to complete
    while (this.isTickInProgress) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    try {
        logger.info('[Matrix] Tick loop stopped. Flushing DB state...');
        
        // Force final sync of any dirty agents that haven't been saved yet
        const dirty = this.cacheManager.getDirtyAgents();
        if (dirty.length > 0) {
             // Use safe sync wrapper
            await this._performSafeSync(dirty);
        }
        
        // Terminate all workers
        logger.info('[Matrix] Terminating worker pool...');
        const terminationPromises = Array.from(this.workerPool.values()).map(w => {
            w.removeAllListeners(); // Prevent 'exit' handlers from firing during shutdown or lingering
            w.postMessage({ type: 'SHUTDOWN' }); // Notify workers for clean exit
            return w.terminate();
        });
        await Promise.allSettled(terminationPromises);
        
        logger.info('[Matrix] Shutdown complete.');
        clearTimeout(shutdownTimer);
        // We do not call process.exit(0) here automatically in case this is embedded in another app,
        // but often in standalone mode you might want to.
    } catch (err) {
        logger.error('[Matrix] Error during shutdown:', err);
        process.exit(1);
    }
  }

  async _performSafeSync(dirtyAgents) {
    if (this.isDbSyncing) {
      logger.warn(`[Matrix] Skipping DB sync for ${dirtyAgents.length} agents - Previous sync still active.`);
      return;
    }

    // P1 FIX: Simplified health check logic
    if (this.dbService && !this.dbService.isHealthy) {
        logger.error('[Matrix] Skipping Sync: Database is unhealthy.');
        return;
    }

    this.isDbSyncing = true;
    try {
      await this.dbService.syncAgents(dirtyAgents);
    } catch (err) {
      logger.error('[Matrix] DB Sync Failed:', err);
    } finally {
      this.isDbSyncing = false;
    }
  }

  async tick() {
    // Prevent overlapping ticks or ticks after shutdown started (double safety)
    if (this.isTickInProgress || !this.isRunning) return; 
    
    this.isTickInProgress = true;

    try {
      this.tickCount++;
      this.eventBus.setCurrentTick(this.tickCount);
      
      this.worldTime = new Date(this.worldTime.getTime() + MINUTES_PER_TICK * 60000);
      global.currentTick = this.tickCount;
      global.worldTime = this.worldTime;

      if (!this.worldState.environment) this.worldState.environment = { globalLight: 0.8, globalTemp: 20 };
      updateWorldState(this.worldTime, this.tickCount, this.worldState, this.eventBus);
      this._handleDynamicWorldEvents();

      const allAgents = this.cacheManager.getAllAgents();
      
      // -- CALCULATE LOCATION DENSITY --
      // Compute density every tick for rebalancing logic and dashboard stats
      this.locationAgentCount.clear();
      for (const agent of allAgents) {
          const loc = agent.locationId || agent.homeLocationId;
          if (loc) {
            this.locationAgentCount.set(loc, (this.locationAgentCount.get(loc) || 0) + 1);
          }
      }

      // -- DYNAMIC REBALANCING --
      if (this.workerPool.size > 1 && this.tickCount % REBALANCE_INTERVAL_TICKS === 0) {
        this._rebalancePartitions(allAgents);
      }
      
      if (this.workerPool.size > 0) {
          await this._runAgentUpdatesInWorkers(allAgents);
      } else {
          for (const agent of allAgents) {
              agent.update(this.tickCount, this.worldTime, this.worldState);
          }
      }

      // PRE-CHECKPOINT FLUSH: Process critical queues (e.g. db:writeMemory) immediately 
      // to ensure state consistency before sync or checkpoints occur.
      this.eventBus.processQueues();

      if (this.tickCount % SYNC_INTERVAL_TICKS === 0) {
        const dirty = this.cacheManager.getDirtyAgents();
        if (dirty.length > 0) {
          // Use safe sync wrapper
          await this._performSafeSync(dirty);
        }
      }

      if (this.tickCount % CHECKPOINT_INTERVAL_TICKS === 0) {
        await this.dbService.createCheckpoint(this.tickCount);
        this.eventBus.queue('db:createCheckpoint', 'high', this.tickCount);
      }

      // POST-CHECKPOINT FLUSH: Process remaining events, including the checkpoint event just queued
      this.eventBus.processQueues();
      this.eventBus.emitNow('matrix:tickComplete', {
        tick: this.tickCount,
        time: this.worldTime.toISOString(),
        agents: allAgents,
        worldState: this.worldState,
        locationAgentCount: Object.fromEntries(this.locationAgentCount) // SERIALIZATION FIX: Convert Map to Object
      });
    } finally {
      this.isTickInProgress = false;
    }
  }

  _rebalancePartitions(allAgents) {
    logger.info(`[Matrix] Checking partition balance (Tick ${this.tickCount})...`);
    
    // 1. Calculate Load per Worker (Agent Count) and Location ownership
    const workerLoads = new Map();
    for (const wId of this.workerPool.keys()) workerLoads.set(wId, 0);

    const locationsByWorker = new Map();
    for (const wId of this.workerPool.keys()) locationsByWorker.set(wId, []);

    for (const [locId, count] of this.locationAgentCount.entries()) {
        const wId = this.partitionMap.get(locId);
        if (wId !== undefined && workerLoads.has(wId)) {
            workerLoads.set(wId, workerLoads.get(wId) + count);
            locationsByWorker.get(wId).push({ locId, count });
        }
    }

    const totalAgents = allAgents.length;
    const avgLoad = totalAgents / this.workerPool.size;
    const tolerance = avgLoad * 0.2; // 20% tolerance

    // 2. Identify Imbalance
    const sortedWorkers = Array.from(workerLoads.entries()).sort((a, b) => b[1] - a[1]); // Descending
    const overloaded = sortedWorkers[0];
    const underloaded = sortedWorkers[sortedWorkers.length - 1];

    if ((overloaded[1] - underloaded[1]) < tolerance) {
        // Balanced enough
        return;
    }

    // 3. Greedily Move Partitions
    // Move locations from Heaviest -> Lightest until balanced or no more moves
    const heavyWorkerId = overloaded[0];
    const lightWorkerId = underloaded[0];
    
    let currentHeavyLoad = overloaded[1];
    let currentLightLoad = underloaded[1];
    const movedLocations = [];

    const heavyLocations = locationsByWorker.get(heavyWorkerId).sort((a, b) => b.count - a.count); // Try moving dense areas first? Or sparse?
    // Actually, moving dense areas fixes imbalance faster, but might overshoot. Let's try biggest fitting block.

    for (const locData of heavyLocations) {
        // If moving this location brings us closer to equality (reduces variance)
        const diffBefore = Math.abs(currentHeavyLoad - currentLightLoad);
        const diffAfter = Math.abs((currentHeavyLoad - locData.count) - (currentLightLoad + locData.count));

        if (diffAfter < diffBefore) {
            // Commit move
            this.partitionMap.set(locData.locId, lightWorkerId);
            
            // Update tracking
            currentHeavyLoad -= locData.count;
            currentLightLoad += locData.count;
            movedLocations.push(locData.locId);
            
            // Update Persistence Map
            if (this.workerLocationMap.has(heavyWorkerId)) {
                this.workerLocationMap.get(heavyWorkerId).delete(locData.locId);
            }
            if (!this.workerLocationMap.has(lightWorkerId)) {
                this.workerLocationMap.set(lightWorkerId, new Set());
            }
            this.workerLocationMap.get(lightWorkerId).add(locData.locId);
        }
    }

    if (movedLocations.length > 0) {
        logger.info(`[Matrix] Rebalanced: Moved ${movedLocations.length} locations from Worker ${heavyWorkerId} to ${lightWorkerId}.`);
        
        // 4. Notify Workers (Simplistic update - Workers should handle 'UPDATE_PARTITIONS' if implemented, 
        // or effectively rely on stateless updates if they don't cache world data too aggressively)
        const heavyWorker = this.workerPool.get(heavyWorkerId);
        const lightWorker = this.workerPool.get(lightWorkerId);

        if (heavyWorker) {
            const locs = Array.from(this.workerLocationMap.get(heavyWorkerId));
            heavyWorker.postMessage({ type: 'UPDATE_PARTITIONS', payload: { locations: locs } });
        }
        if (lightWorker) {
            const locs = Array.from(this.workerLocationMap.get(lightWorkerId));
            lightWorker.postMessage({ type: 'UPDATE_PARTITIONS', payload: { locations: locs } });
        }
    }
  }

  _handleDynamicWorldEvents() {
    let worldChanged = false;
    this.worldState.world_events = (this.worldState.world_events || []).filter(e => {
      e.duration--;
      if (e.duration <= 0) worldChanged = true;
      return e.duration > 0;
    });
    
    if (worldChanged) {
      FiniteStateMachine.clearPathCache();
      this._precomputeAffordanceCache();
      this.workerPool.forEach(w => w.postMessage({ type: 'CLEAR_PATH_CACHE' }));
      
      // COPY-ON-WRITE: Update the graph snapshot when world events modify state
      this.graphSnapshot = this._createGraphSnapshot();
    }
  }

  async _runAgentUpdatesInWorkers(allAgents) {
    const workerPayloads = new Map();
    // Initialize payloads only for active workers
    for (const workerId of this.workerPool.keys()) {
        workerPayloads.set(workerId, { agentsData: [] });
    }

    // Get list of active workers for fallbacks
    const activeWorkers = Array.from(this.workerPool.keys());

    for (const agent of allAgents) {
      let workerId = this.agentWorkerMap.get(agent.id);
      
      // Robustness: Handle agents assigned to missing/dead workers
      if (workerId === undefined || !this.workerPool.has(workerId)) {
          if (activeWorkers.length > 0) {
            // Assign to a valid worker (simple hash distribution for stability)
            workerId = activeWorkers[agent.id.charCodeAt(0) % activeWorkers.length];
            this.agentWorkerMap.set(agent.id, workerId);
            // Update the load map for this worker
            if (this.workerAgentLoads.has(workerId)) {
                this.workerAgentLoads.get(workerId).add(agent.id);
            }
          } else {
            // If NO workers are active, we can't process. 
            // This case should be caught by global crash handlers, but we skip to avoid runtime errors.
            continue; 
          }
      }
      
      const payload = workerPayloads.get(workerId);
      if (payload) {
          payload.agentsData.push(agent.serialize());
      }
    }

    const tickPayload = {
      tickCount: this.tickCount,
      worldTime: this.worldTime,
      worldState: this.worldState,
      locationAgentCount: Object.fromEntries(this.locationAgentCount), // SERIALIZATION FIX: Convert Map to Object
      worldEvents: this.worldState.world_events,
      graphSnapshot: this.graphSnapshot // IMMUTABLE SNAPSHOT: Pass the frozen graph to workers
    };

    const activeWorkerPromises = [];
    const activeWorkerIds = []; // NEW: Track IDs to handle specific failures

    for (const [workerId, worker] of this.workerPool.entries()) {
      // HEALTH CHECK: Do not dispatch work to dead or hanging workers
      // CHECK CIRCUIT BREAKER TOO: Do not dispatch if circuit is open
      const health = this.workerHealth.get(workerId);
      if (health !== 'healthy') {
        logger.warn(`[Matrix] Skipping tick for worker ${workerId} (State: ${health})`);
        continue;
      }

      const payload = workerPayloads.get(workerId);
      if (payload && payload.agentsData.length > 0) {
        const tickPromise = new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => { 
              // TIMEOUT HANDLING
              this.workerTickPromises.delete(workerId);
              logger.error(`[Matrix] Worker ${workerId} TIMED OUT. Terminating...`);
              
              // Prevent race conditions by marking as hanging
              this.workerHealth.set(workerId, 'hanging');
              
              // Terminate the worker (This will trigger _handleWorkerExit, which respawns it)
              worker.terminate();
              
              reject(new Error(`Worker ${workerId} TIMEOUT`)); 
          }, WORKER_TIMEOUT_MS);
          
          this.workerTickPromises.set(workerId, (result) => { 
              clearTimeout(timeoutId); 
              resolve(result); 
          });
        });
        
        activeWorkerPromises.push(tickPromise);
        activeWorkerIds.push(workerId);
        worker.postMessage({ type: 'TICK', payload: { ...tickPayload, agentsData: payload.agentsData } });
      }
    }

    // NEW: Use allSettled to allow partial success
    const results = await Promise.allSettled(activeWorkerPromises);

    this.worldState.locationSocialContext.clear();
    let allWalOps = [], allLogEvents = [], allUpdatedAgents = [];

    // Process results
    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const workerId = activeWorkerIds[i];
        let isValid = false;
        let data = null;

        if (result.status === 'fulfilled') {
            data = result.value;
            isValid = this._validateWorkerResult(workerId, data);
        } else {
             logger.error(`[Matrix] Worker ${workerId} failed tick: ${result.reason}`);
        }

        if (isValid && data) {
            // SUCCESSFUL AND VALID
            if (data.updatedAgents) {
                this.cacheManager.mergeAgentUpdates(data.updatedAgents);
                allUpdatedAgents.push(...data.updatedAgents);
            }
            
            if (data.socialContext) {
                for (const [locId, agentsList] of data.socialContext) {
                    if (!this.worldState.locationSocialContext.has(locId)) {
                        this.worldState.locationSocialContext.set(locId, []);
                    }
                    this.worldState.locationSocialContext.get(locId).push(...agentsList);
                }
            }
            
            if (data.walOps) allWalOps = allWalOps.concat(data.walOps);
            if (data.logEvents) allLogEvents = allLogEvents.concat(data.logEvents);

        } else {
            // FAILURE HANDLING: Worker rejected OR Invalid Data
            if (result.status === 'fulfilled') {
                 logger.error(`[Matrix] Worker ${workerId} marked unhealthy due to invalid data.`);
            }
            
            // 1. Redistribute load immediately for next tick
            this._handlePermanentWorkerLoss(workerId);
            
            // 2. Queue respawn to restore pool capacity (fire and forget)
            // CHECK CIRCUIT BREAKER BEFORE RESPAWNING
            if (this._checkCircuitBreaker(workerId)) {
                this._spawnWorker(workerId).catch(err => {
                    logger.error(`[Matrix] Failed to respawn failed worker ${workerId}:`, err);
                });
            } else {
                this.workerHealth.set(workerId, 'circuit_open');
                logger.error(`[Matrix] Respawn aborted for ${workerId}: Circuit Breaker Open.`);
            }
            
            // Note: Data from this worker is implicitly rolled back (not merged).
        }
    }

    this._processWorkerOutputs(allWalOps, allLogEvents);
    this._updateAgentDistribution(allUpdatedAgents);
  }

  _processWorkerOutputs(walOps, logEvents) {
    for (const walOp of walOps) {
      if (walOp.op === 'db:writeMemory') {
        this.eventBus.queue('db:writeMemory', 'medium', walOp.data.agentId, walOp.data.tick, walOp.data.memory);
      } else {
        // FIX 3: Treat isHealthy as a boolean property, NOT a function
        if (this.dbService && this.dbService.isHealthy) { // Defensive check
            this.dbService.logSimulationEvent(this.tickCount, walOp.op, walOp.data);
        }
      }
    }
    for (const log of logEvents) this.eventBus.queue(...log);
  }

  _updateAgentDistribution(updatedAgents) {
    for (const agentData of updatedAgents) {
      const newLocationId = agentData.locationId;
      if (!newLocationId) continue;
      
      const correctWorkerId = this.partitionMap.get(newLocationId);
      const currentWorkerId = this.agentWorkerMap.get(agentData.id);
      
      // Only migrate if correctWorkerId is valid and active
      if (correctWorkerId !== undefined && correctWorkerId !== currentWorkerId) {
          if (this.workerPool.has(correctWorkerId)) {
            this.agentWorkerMap.set(agentData.id, correctWorkerId);
          }
      }
    }
  }
}

export default Matrix;