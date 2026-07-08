import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { Worker } from 'worker_threads';
import logger from './logger.js';

class DbService {
  constructor(dbPath) {
    this.dbPath = dbPath || path.join(process.cwd(), 'nyc_1999.db');
    this.db = null;
    this.statements = {};
    this.isInitialized = false; 
    
    // Health Monitoring
    this.isHealthy = false;
    this.healthCheckInterval = null;
    this.healthCheckCounter = 0; // For infrequent metrics logging
    this.reconnectAttempts = 0;
    this.MAX_RECONNECT_ATTEMPTS = 5;
    this.CIRCUIT_OPEN = false;
    
    // Watchdog / Safety Config
    this.QUERY_TIMEOUT_MS = 2000; 
    this.MAX_QUERY_ROWS = 20000;
    
    // Observability / Metrics
    this.metrics = {
        ops: {}, // Stores stats per operation type
        pruning: { runs: 0, eventsDeleted: 0, memoriesDeleted: 0 },
        errors: 0,
        slowQueries: 0
    };
    
    // Maintenance counters
    this.pruneCounter = 0;
    this.PRUNE_INTERVAL = 100; 
    
    // CONSTRUCTOR CHANGE: Removed synchronous side effects (connect/initSchema)
    // You must now call .init() explicitly.
  }

  /**
   * Initialize the database service.
   * Connects to DB, sets up schema, and starts health checks.
   * MUST be called before using the service.
   */
  async init() {
      if (this.isInitialized) return;

      logger.info('[DbService] Initializing service...');
      try {
          this.connect();
          this.initSchema();
          this.startHealthCheck();
          // Ensure flag is set if initSchema didn't throw
          if (!this.isInitialized) this.isInitialized = true;
      } catch (err) {
          logger.error('[DbService] Initialization failed', { error: err });
          throw err; // Propagate to caller for handling
      }
  }

  connect() {
    try {
      this.db = new Database(this.dbPath, { verbose: null }); 
      
      // SAFETY: Run integrity check on startup to detect file corruption
      try {
          const check = this.db.pragma('quick_check');
          if (check[0].quick_check !== 'ok') {
              throw new Error(`Integrity check failed: ${check[0].quick_check}`);
          }
      } catch (corruptionError) {
          logger.error('[DbService] CORRUPTION DETECTED', { error: corruptionError });
          
          if (this.db && this.db.open) {
              try { this.db.close(); } catch(e) {}
          }
          
          this.recoverDatabase(); 
          
          // Re-open database after recovery (restored or fresh)
          this.db = new Database(this.dbPath, { verbose: null });
      }

      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL'); 
      
      // CONFIGURABLE CACHE:
      // Default to -64000 (64MB) if not set. Negative N = N kilobytes.
      const cacheSize = process.env.DB_CACHE_SIZE_KB ? parseInt(process.env.DB_CACHE_SIZE_KB) : -64000;
      this.db.pragma(`cache_size = ${cacheSize}`);
      
      // DEADLOCK PROTECTION:
      // Block for up to 3000ms natively if DB is locked before throwing SQLITE_BUSY.
      // This handles minor contention without needing the retry loop.
      this.db.pragma('busy_timeout = 3000');
      
      this.isHealthy = true;
      this.CIRCUIT_OPEN = false;
      logger.info(`[DbService] Connected to SQLite database (WAL Mode, Cache: ${cacheSize})`);
    } catch (err) {
      logger.error('[DbService] Failed to connect', { error: err });
      throw err;
    }
  }

  recoverDatabase() {
      const backupPath = path.join(path.dirname(this.dbPath), 'backup_daily.db');
      
      // Quarantine the corrupt file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const corruptPath = `${this.dbPath}.corrupt.${timestamp}`;
      
      if (fs.existsSync(this.dbPath)) {
          try {
             fs.renameSync(this.dbPath, corruptPath);
             logger.warn(`[DbService] Corrupt database quarantined to: ${corruptPath}`);
          } catch (e) {
             logger.error('[DbService] Failed to quarantine corrupt file', { error: e });
          }
      }

      if (fs.existsSync(backupPath)) {
          logger.warn(`[DbService] Restoring database from backup: ${backupPath}`);
          try {
              fs.copyFileSync(backupPath, this.dbPath);
              logger.info('[DbService] Restoration complete.');
          } catch (e) {
              logger.error('[DbService] Failed to restore backup', { error: e });
          }
      } else {
          logger.error('[DbService] No backup found. Starting with fresh database.');
          // Fall through: The next new Database() call in connect() will create a fresh file
      }
  }

  startHealthCheck() {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    // Run health check every 30 seconds
    this.healthCheckInterval = setInterval(() => this.checkHealth(), 30000);
  }

  checkHealth() {
    // Increment counter for periodic metric logging
    this.healthCheckCounter++;

    if (this.CIRCUIT_OPEN && this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) return;

    try {
      if (!this.db) throw new Error('Database handle is missing');
      this.db.prepare('SELECT 1').get();
      
      // MEMORY MONITORING
      const mem = process.memoryUsage();
      const rssMB = Math.round(mem.rss / 1024 / 1024);
      if (rssMB > 1536) {
          logger.warn(`[DbService] High Memory Usage: RSS=${rssMB}MB. Check DB_CACHE_SIZE_KB or leaks.`);
      }

      // METRICS LOGGING (Every 5 minutes aka 10 checks)
      if (this.healthCheckCounter % 10 === 0) {
          this.logMetrics(rssMB);
      }

      if (!this.isHealthy) {
        this.isHealthy = true;
        this.reconnectAttempts = 0;
        logger.info('[DbService] Connection health restored.');
      }
    } catch (err) {
      this.handleConnectionFailure(err);
    }
  }

  logMetrics(rssMB) {
      const stats = this.getMetrics();
      logger.info('[DbService] Performance Snapshot:', {
          rssMB,
          dbSizeMB: stats.storage.dbSizeMB,
          walSizeMB: stats.storage.walSizeMB,
          slowQueries: stats.performance.slowQueries,
          ops: stats.performance.ops,
          pruning: stats.maintenance
      });
  }

  getMetrics() {
      // Get File Sizes
      let dbSizeMB = 0, walSizeMB = 0;
      try {
          const dbStat = fs.statSync(this.dbPath);
          dbSizeMB = (dbStat.size / 1024 / 1024).toFixed(2);
          const walPath = `${this.dbPath}-wal`;
          if (fs.existsSync(walPath)) {
              const walStat = fs.statSync(walPath);
              walSizeMB = (walStat.size / 1024 / 1024).toFixed(2);
          }
      } catch(e) {}

      return {
          storage: { dbSizeMB, walSizeMB },
          performance: {
              ops: this.metrics.ops,
              slowQueries: this.metrics.slowQueries,
              errors: this.metrics.errors
          },
          maintenance: this.metrics.pruning
      };
  }

  handleConnectionFailure(err) {
    this.metrics.errors++;
    this.isHealthy = false;
    logger.error('[DbService] Health Check Failed', { error: err });

    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      if (!this.CIRCUIT_OPEN) {
        this.CIRCUIT_OPEN = true;
        logger.error('[DbService] CIRCUIT BREAKER OPEN: Max retries reached. DB operations suspended.');
      }
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    logger.warn(`[DbService] Attempting reconnect (${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS}) in ${delay}ms...`);
    setTimeout(() => this.attemptReconnect(), delay);
  }

  attemptReconnect() {
    try {
      logger.info('[DbService] Reconnecting...');
      if (this.db) {
        try { this.db.close(); } catch (e) {}
      }
      this.connect();
      // Ensure statements are refreshed after reconnection to bind to new DB instance
      this.refreshStatements(); 
      this.isHealthy = true;
      this.reconnectAttempts = 0;
      this.CIRCUIT_OPEN = false;
      logger.info('[DbService] Reconnection successful.');
    } catch (err) {
      this.metrics.errors++;
      logger.error('[DbService] Reconnection failed', { error: err });
    }
  }

  initSchema() {
    if (!this.db) return;
    if (this.isInitialized) return;

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY, 
          name TEXT,
          state TEXT, 
          locationId TEXT,
          money REAL,
          energy INTEGER,
          hunger INTEGER,
          social INTEGER,
          data TEXT
        );
      `);
      // PERFORMANCE: Index for querying agents by state (e.g., 'sleeping')
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_state ON agents(state);`);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS checkpoints (
          tick INTEGER PRIMARY KEY,
          timestamp TEXT
        );
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS simulation_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tick INTEGER,
          type TEXT,
          data TEXT,
          timestamp TEXT DEFAULT CURRENT_TIMESTAMP
        );
      `);
      
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_simulation_events_tick ON simulation_events(tick);
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          memory_id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT,
          tick INTEGER,
          memory_text TEXT,
          type TEXT DEFAULT 'general',
          importance INTEGER DEFAULT 1,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        -- COMPOSITE INDEX: Optimized for retrieving recent memories per agent
        CREATE INDEX IF NOT EXISTS idx_memories_agent_tick ON memories(agent_id, tick DESC);
        -- INDEX: Optimized for global pruning by tick
        CREATE INDEX IF NOT EXISTS idx_memories_tick ON memories(tick);
      `);

      this.refreshStatements();
      this.isInitialized = true;
      logger.info('[DbService] Schema initialized.');
    } catch (err) {
      this.statements = {};
      this.saveAgentsBatch = null;
      this.isInitialized = false;
      logger.error('[DbService] Schema init failed', { error: err });
      throw err;
    }
  }

  /**
   * Refreshes prepared statements.
   * Critical to call after any runtime schema modification (migrations).
   */
  refreshStatements() {
      // Clear cache to ensure no stale references linger
      this.statements = {};
      this.saveAgentsBatch = null;
      this._prepareStatements();
      logger.info('[DbService] Prepared statements refreshed.');
  }

  /**
   * Executes a schema modification and automatically refreshes statements.
   * Use this for runtime migrations to avoid "statement invalid" errors.
   */
  execSchemaModification(sql) {
      if (!this.db) throw new Error('Database not connected');
      try {
          this.db.exec(sql);
          this.refreshStatements();
      } catch (err) {
          logger.error('[DbService] Schema modification failed', { error: err, sql });
          throw err;
      }
  }

  _prepareStatements() {
    this.statements.saveCheckpoint = this.db.prepare('INSERT OR REPLACE INTO checkpoints (tick, timestamp) VALUES (?, ?)');
    this.statements.getLatestCheckpoint = this.db.prepare('SELECT tick FROM checkpoints ORDER BY tick DESC LIMIT 1');
    this.statements.pruneEvents = this.db.prepare("DELETE FROM simulation_events WHERE tick < ?");
    
    try {
        this.statements.pruneMemories = this.db.prepare("DELETE FROM memories WHERE tick < ?");
    } catch (e) {
        logger.warn('[DbService] Memory pruning disabled. (Table schema mismatch? Check if "tick" column exists in memories table)');
        this.statements.pruneMemories = null;
    }

    this.statements.logEvent = this.db.prepare('INSERT INTO simulation_events (tick, type, data) VALUES (?, ?, ?)');

    // LAZY LOADING OPTIMIZATION:
    // 1. Light query: Fetch only core fields, exclude massive 'data' blob
    this.statements.getAllAgentsLight = this.db.prepare('SELECT id, name, state, locationId, money, energy, hunger, social FROM agents');
    
    // 2. Data query: Fetch specific 'data' blob on demand
    this.statements.getAgentData = this.db.prepare('SELECT data FROM agents WHERE id = ?');

    // 3. Full query: Fetch everything (Used for initial hydration)
    this.statements.getAllAgents = this.db.prepare('SELECT * FROM agents');

    this.statements.upsertAgent = this.db.prepare(`
        INSERT INTO agents (id, name, state, locationId, money, energy, hunger, social, data)
        VALUES (@id, @name, @state, @locationId, @money, @energy, @hunger, @social, @data)
        ON CONFLICT(id) DO UPDATE SET
            state=excluded.state,
            locationId=excluded.locationId,
            money=excluded.money,
            energy=excluded.energy,
            hunger=excluded.hunger,
            social=excluded.social,
            data=excluded.data
    `);
    
    this.saveAgentsBatch = this.db.transaction((agents) => {
        for (const agent of agents) {
            const { id, name, state, locationId, money, energy, hunger, social, ...rest } = agent;
            this.statements.upsertAgent.run({
                id, name, state, locationId, money, energy, hunger, social,
                data: JSON.stringify(rest)
            });
        }
    });
  }

  // Helper to record internal metrics
  _recordMetric(name, duration) {
      if (!this.metrics.ops[name]) {
          this.metrics.ops[name] = { count: 0, totalMs: 0, avgMs: 0, maxMs: 0 };
      }
      const m = this.metrics.ops[name];
      m.count++;
      m.totalMs += duration;
      m.avgMs = Math.round(m.totalMs / m.count);
      if (duration > m.maxMs) m.maxMs = duration;
  }

  /**
   * @description Executes a read statement with a strict timeout using iterators.
   * Prevents runaway queries from blocking the main thread.
   * @param {Database.Statement} stmt - The prepared statement to run.
   * @param {...any} params - Parameters for the statement.
   * @returns {Array<object>} The resulting rows.
   * @throws {Error} If query exceeds timeout or row safety limit.
   */
  _safeRead(stmt, ...params) {
      const start = Date.now();
      const rows = [];
      
      // Use iterate() instead of all() to check time/count during fetch
      for (const row of stmt.iterate(...params)) {
          rows.push(row);
          
          // Check checks every 100 rows to minimize overhead
          if (rows.length % 100 === 0) {
              if (Date.now() - start > this.QUERY_TIMEOUT_MS) {
                  this.metrics.slowQueries++;
                  throw new Error(`[DbService] Query Timeout: Exceeded ${this.QUERY_TIMEOUT_MS}ms. (Fetched ${rows.length} rows)`);
              }
              if (rows.length > this.MAX_QUERY_ROWS) {
                  this.metrics.slowQueries++;
                  throw new Error(`[DbService] Query Safety Limit: Exceeded ${this.MAX_QUERY_ROWS} rows.`);
              }
          }
      }
      
      this._recordMetric('read_query', Date.now() - start);
      return rows;
  }

  /**
   * @description Wraps a write operation in performance measurement and logging.
   * @param {string} name - The name of the operation for metrics logging.
   * @param {() => Promise<any>|any} fn - The function containing the operation.
   * @returns {Promise<any>} The result of the operation function.
   * @throws {Error} Propagates any error from the operation.
   */
  async _measure(name, fn) {
      const start = Date.now();
      try {
          // Changed from await fn() to fn() to support non-async functions, 
          // and wrap result in Promise.resolve for consistent awaitable return.
          const res = await Promise.resolve(fn());
          const duration = Date.now() - start;
          
          this._recordMetric(name, duration);
          
          if (duration > this.QUERY_TIMEOUT_MS) {
              this.metrics.slowQueries++;
              logger.warn(`[DbService] SLOW OPERATION detected: ${name} took ${duration}ms (Threshold: ${this.QUERY_TIMEOUT_MS}ms)`);
          }
          return res;
      } catch (e) {
          this.metrics.errors++;
          throw e;
      }
  }

  /**
   * Helper to run writes with retry logic (Exponential Backoff)
   * Prevents app freeze on heavy contention.
   * @param {string} operationName - Name of the operation.
   * @param {() => Promise<any>|any} fn - The function to execute.
   * @returns {Promise<any>} The result of the function.
   * @throws {Error} If the operation fails after all retries.
   */
  async _executeWithRetry(operationName, fn) {
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await this._measure(operationName, async () => fn());
        } catch (err) {
            const isBusy = err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED';
            if (isBusy && attempt < MAX_RETRIES) {
                const delay = 200 * Math.pow(2, attempt); // 400ms, 800ms...
                logger.warn(`[DbService] ${operationName} locked/busy. Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw err;
            }
        }
    }
  }

  logSimulationEvent(tick, type, data) {
      if (this.CIRCUIT_OPEN) return; 
      if (!this.isInitialized) {
          throw new Error('[DbService] Log event failed: Service not initialized');
      }
      try {
          const payload = typeof data === 'string' ? data : JSON.stringify(data);
          this.statements.logEvent.run(tick, type, payload);
      } catch (err) {
          this.metrics.errors++;
          logger.error('[DbService] Failed to log event', { error: err, tick, type });
      }
  }

  async syncAgents(agents) {
      if (this.CIRCUIT_OPEN) {
          logger.warn('[DbService] Skipping syncAgents: Circuit Open');
          return;
      }
      if (!agents || agents.length === 0) return;
      
      if (!this.isInitialized || !this.saveAgentsBatch) {
          throw new Error('[DbService] CRITICAL: Cannot sync agents. Transaction handler not initialized.');
      }

      // WRAPPED: Async Retry Logic + Watchdog Measurement
      try {
          await this._executeWithRetry('syncAgents', () => {
              const data = agents.map(a => a.serialize ? a.serialize() : a);
              this.saveAgentsBatch(data);
          });
      } catch (err) {
          logger.error('[DbService] Agent sync failed after retries', { error: err, count: agents.length });
          this.checkHealth(); 
      }
  }

  async createCheckpoint(tick) {
    if (this.CIRCUIT_OPEN) return;
    if (!this.isInitialized) throw new Error('[DbService] Checkpoint failed: Service not initialized');
    
    // WRAPPED: Async Retry Logic + Watchdog Measurement
    try {
        await this._executeWithRetry('createCheckpoint', () => {
            const timestamp = new Date().toISOString();
            this.statements.saveCheckpoint.run(tick, timestamp);
            
            this.pruneCounter++;
            if (this.pruneCounter >= this.PRUNE_INTERVAL) {
                const eventDeleteResult = this.statements.pruneEvents.run(tick - 1000);
                let memoryDeleteCount = 0;
                if (this.statements.pruneMemories) {
                    const memoryDeleteResult = this.statements.pruneMemories.run(tick - 5000);
                    memoryDeleteCount = memoryDeleteResult.changes;
                }
                
                // Track Pruning metrics
                this.metrics.pruning.runs++;
                this.metrics.pruning.eventsDeleted += eventDeleteResult.changes;
                this.metrics.pruning.memoriesDeleted += memoryDeleteCount;

                // EXPLICIT WAL CHECKPOINT:
                this.db.pragma('wal_checkpoint(TRUNCATE)');
                
                this.pruneCounter = 0;
                logger.info(`[DbService] Maintenance: Pruned ${eventDeleteResult.changes} events, ${memoryDeleteCount} memories, and flushed WAL.`);
            }
        });
    } catch (err) {
      logger.error('[DbService] Checkpoint failed', { error: err, tick });
      this.checkHealth();
    }
  }

  async backup(backupName = 'daily') {
      if (this.CIRCUIT_OPEN) return;
      
      const backupPath = path.join(path.dirname(this.dbPath), `backup_${backupName}.db`);
      logger.info(`[DbService] Starting backup to ${backupPath} (Worker)...`);

      // WORKER THREAD BACKUP: Prevents blocking the main event loop
      return new Promise((resolve) => {
        const workerCode = `
          const { parentPort, workerData } = require('worker_threads');
          const Database = require('better-sqlite3');
          
          try {
            // Read-only connection avoids locking writers
            const db = new Database(workerData.src, { readonly: true });
            
            db.backup(workerData.dest)
              .then(() => {
                db.close();
                parentPort.postMessage({ success: true });
              })
              .catch(err => {
                db.close();
                parentPort.postMessage({ success: false, error: err.message });
              });
          } catch(err) {
            parentPort.postMessage({ success: false, error: err.message });
          }
        `;

        const worker = new Worker(workerCode, {
          eval: true,
          workerData: { src: this.dbPath, dest: backupPath }
        });

        worker.on('message', (result) => {
          if (result.success) {
            logger.info('[DbService] Backup complete.');
          } else {
            this.metrics.errors++;
            logger.error('[DbService] Backup failed (Worker)', { error: result.error });
          }
          worker.terminate();
          resolve(); 
        });

        worker.on('error', (err) => {
          this.metrics.errors++;
          logger.error('[DbService] Backup worker error', { error: err });
          worker.terminate();
          resolve();
        });
        
        worker.on('exit', (code) => {
             if (code !== 0) {
                 logger.warn(`[DbService] Backup worker exited with code ${code}`);
                 resolve();
             }
        });
      });
  }

  /**
   * Retrieves lightweight agent records (excludes 'data').
   * Useful for status checks or visualizations.
   */
  getAgentsLight() {
      if (!this.isInitialized) return [];
      try {
          return this.statements.getAllAgentsLight.all();
      } catch (err) {
          this.metrics.errors++;
          logger.error('[DbService] getAgentsLight failed', { error: err });
          return [];
      }
  }

  /**
   * Lazy loads the heavy data blob for a specific agent.
   */
  getAgentData(agentId) {
      if (!this.isInitialized) return null;
      try {
          const row = this.statements.getAgentData.get(agentId);
          return row && row.data ? JSON.parse(row.data) : null;
      } catch (err) {
          this.metrics.errors++;
          logger.error('[DbService] getAgentData failed', { error: err, agentId });
          return null;
      }
  }

  /**
   * @description Loads all agent state from the latest checkpoint into memory.
   * This operation is moved to a separate worker to prevent main thread blocking (P4).
   * @returns {Promise<{lastTick: number, baseState: {agents: Array<object>}}>} The loaded simulation state.
   * @throws {Error} If the worker fails or data is corrupted.
   */
  async loadStateFromRecovery() {
    if (!this.isInitialized || !this.statements.getLatestCheckpoint) {
        throw new Error('[DbService] Cannot load state: DB not initialized.');
    }

    // Since we cannot run better-sqlite3 statements inside this worker (it must open its own connection),
    // we pass the DB path and let the worker manage the synchronous heavy load internally.
    const latest = this.statements.getLatestCheckpoint.get();
    const lastTick = latest ? latest.tick : 0;

    if (!latest) {
      logger.warn('[DbService] No checkpoint found. Starting fresh simulation.');
      return { lastTick: 0, baseState: { agents: [] } };
    }

    logger.info(`[DbService] Loading state from tick ${lastTick} (Off-thread load)...`);
      
    return new Promise((resolve, reject) => {
      // Worker code to perform the synchronous DB read/JSON parsing
      const workerCode = `
        const { parentPort, workerData } = require('worker_threads');
        const Database = require('better-sqlite3');
        const fs = require('fs');

        try {
            // Open a new read-only connection
            const db = new Database(workerData.dbPath, { readonly: true });
            
            const start = Date.now();
            const QUERY_TIMEOUT_MS = 10000; // Longer timeout for this heavy read
            const stmt = db.prepare('SELECT * FROM agents');
            const agents = [];
            let rowCount = 0;
            const errors = [];
            
            // Stream rows and process synchronously within the worker thread
            for (const row of stmt.iterate()) {
                rowCount++;
                
                if (rowCount % 1000 === 0 && Date.now() - start > QUERY_TIMEOUT_MS) {
                    console.warn(\`[RecoveryWorker] Load taking long... (\${rowCount} agents processed)\`);
                }

                let data = {};
                try {
                  if (row.data) {
                      data = JSON.parse(row.data);
                  }
                } catch (e) {
                    errors.push(row.id);
                }

                agents.push({
                    ...data, 
                    id: row.id,
                    name: row.name,
                    state: row.state,
                    locationId: row.locationId,
                    money: row.money,
                    energy: row.energy,
                    hunger: row.hunger,
                    social: row.social
                });
            }
            
            db.close();
            
            parentPort.postMessage({ agents, errors });

        } catch(err) {
            parentPort.postMessage({ error: err.message, stack: err.stack });
        }
      `;

      const worker = new Worker(workerCode, {
        eval: true,
        workerData: { dbPath: this.dbPath }
      });

      worker.on('message', (result) => {
        worker.terminate();
        if (result.error) {
          logger.error('[DbService] Load Worker failed:', { error: result.error, stack: result.stack });
          reject(new Error(`Recovery failed in worker: ${result.error}`));
        } else {
          if (result.errors.length > 0) {
            logger.warn(`[DbService] Recovered with ${result.errors.length} agents using partial state due to data corruption.`);
          }
          resolve({
            lastTick: lastTick,
            baseState: { agents: result.agents },
          });
        }
      });

      worker.on('error', (err) => {
        worker.terminate();
        logger.error('[DbService] Load Worker error (Uncaught)', { error: err });
        reject(err);
      });
      
      worker.on('exit', (code) => {
          if (code !== 0) {
              logger.error(`[DbService] Load Worker exited with code ${code}`);
              reject(new Error(`Load worker exited non-zero: ${code}`));
          }
      });
    });
  }
  
  addMemory(agentId, tick, description, importance = 1) { 
      if (this.CIRCUIT_OPEN) return;
      if (!this.isInitialized) {
         logger.error('[DbService] addMemory failed: Service not initialized');
         return;
      }
      try {
          this.db.prepare("INSERT INTO memories (agent_id, tick, memory_text, importance) VALUES (?, ?, ?, ?)").run(agentId, tick, description, importance);
      } catch(e) { 
          this.metrics.errors++;
          logger.error('[DbService] addMemory failed', { error: e, agentId, tick }); 
      }
  }

  writeToMemoryBatch(payloads) {
      if (this.CIRCUIT_OPEN) return;
      if (!payloads.length) return;
      if (!this.isInitialized) {
         logger.error('[DbService] writeToMemoryBatch failed: Service not initialized');
         return; 
      }
      const insert = this.db.prepare("INSERT INTO memories (agent_id, tick, memory_text, importance) VALUES (?, ?, ?, ?)");
      const insertMany = this.db.transaction((items) => {
        for (const item of items) insert.run(item.agentId, item.tick, item.description, item.importance);
      });
      try {
        insertMany(payloads);
      } catch(e) { 
          this.metrics.errors++;
          logger.error('[DbService] writeToMemoryBatch failed', { error: e, count: payloads.length }); 
      }
  }

  getAgentMemories(agentId, limit = 10) { 
      if (this.CIRCUIT_OPEN) return [];
      if (!this.isInitialized) return [];
      try {
          // SAFETY: Use _safeRead, though LIMIT ? usually protects this specific query.
          // It guards against a bad caller passing limit=999999
          const stmt = this.db.prepare("SELECT * FROM memories WHERE agent_id = ? ORDER BY tick DESC LIMIT ?");
          return this._safeRead(stmt, agentId, limit);
      } catch (e) { 
          this.metrics.errors++;
          logger.error('[DbService] getAgentMemories failed', { error: e, agentId });
          return []; 
      }
  }
}

export default DbService;