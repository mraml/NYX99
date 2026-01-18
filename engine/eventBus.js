import { EventEmitter } from 'events';

/**
 * eventBus.js
 *
 * A "Phase 3" time-travel-ready messaging system.
 * Features:
 * - Priority Queues & Batching (Phase 2)
 * - Event Auditing/History (Phase 3)
 * - Event Profiler (Phase 3)
 * (MODIFIED v4.1: Implemented periodic history trimming to prevent memory leak.)
 * (MODIFIED v4.9: Implemented lazy argument evaluation in queue() for performance.)
 * (MODIFIED v5.0: Added compatibility alias 'emit' -> 'emitNow'.)
 * (MODIFIED v6.0: Fixed closure memory leak, deep cloning history, optimized trim, hardened batch processing.)
 */
class EventBus {
  constructor(options = {}) {
    this._emitter = new EventEmitter();
    this.debug = false;
    this._currentTick = 0;

    // --- Phase 2: Priority Queues ---
    // Stores { event: string, args: Array } (Changed from argsFn to avoid closure leak)
    this._queues = {
      high: [],
      medium: [],
      low: [],
    };

    // --- Phase 2: Event Batching ---
    this._batchableEvents = new Set([
      'agent:moved',
      // 'db:updateRelationship' is removed as it's no longer a DB table
      'db:writeMemory',
      'db:writeWAL',
    ]);
    this._batchQueues = new Map();

    // --- Phase 3: Audit Stream (FIXED MEMORY LEAK) ---
    this._eventHistory = [];
    this._maxHistoryEvents = options.maxHistoryEvents || 5000; // Max events in memory
    this._maxHistoryTicks = options.maxHistoryTicks || 1000;   // Max tick age to retain
    this._historyPaused = false;
    this._lastHistoryTrim = 0; // Track when we last trimmed
    this._historyTrimInterval = 50; // Trim more frequently (was 100 implicitly)

    // --- Phase 3: Profiler ---
    this._eventProfiler = new Map();
    this._performanceMetrics = {
      totalEventsProcessed: 0,
      totalBatchesProcessed: 0,
      lastProcessDuration: 0,
    };
  }

  /**
   * Sets the current simulation tick.
   * This is CRITICAL for the audit stream.
   * @param {number} tick
   */
  setCurrentTick(tick) {
    if (typeof tick !== 'number' || tick < 0) {
      console.warn(`[EventBus] Invalid tick value: ${tick}`);
      return;
    }
    
    this._currentTick = tick;
    
    // --- FIX: Periodic history trimming to prevent memory leak ---
    // Trim more frequently to keep array sizes manageable
    if (tick - this._lastHistoryTrim >= this._historyTrimInterval) {
      this._trimHistory();
      this._lastHistoryTrim = tick;
    }
  }

  /**
   * Sets the debug trace logging on or off.
   * @param {boolean} enabled
   */
  setDebug(enabled) {
    this.debug = !!enabled;
  }

  /**
   * Internal method to log an event to history and profiler.
   * @private
   * @param {string} event
   * @param {Array} args - Array of arguments.
   */
  _logEvent(event, args) {
    // 2. Increment Profiler
    this._eventProfiler.set(event, (this._eventProfiler.get(event) || 0) + 1);

    // 3. Add to History
    if (this._historyPaused) return;

    // [FIX 2] History Shallow Copy Creates Dangling References
    // Use structuredClone for deep copy if available, or fall back to JSON parse/stringify
    // This prevents history mutation when objects are modified later by agents.
    let deepArgs;
    try {
        if (typeof structuredClone === 'function') {
            deepArgs = structuredClone(args);
        } else {
            deepArgs = JSON.parse(JSON.stringify(args));
        }
    } catch (e) {
        // Fallback for circular references or non-serializable data
        deepArgs = [...args]; 
    }

    this._eventHistory.push({
      tick: this._currentTick,
      timestamp: Date.now(),
      event,
      args: deepArgs,
    });

    // 4. Trim history if over max events (safety check)
    if (this._eventHistory.length > this._maxHistoryEvents) {
      this._eventHistory.shift(); // Remove oldest event
    }
  }

  /**
   * Trims old events from history based on tick age.
   * This prevents unbounded memory growth.
   * [FIX 3] Optimized to O(1) slice instead of O(n) filter
   * @private
   */
  _trimHistory() {
    if (this._eventHistory.length === 0) return;
    
    const cutoffTick = this._currentTick - this._maxHistoryTicks;
    
    // Find the index where events become "new enough"
    // Since history is pushed in chronological order, we can find the first valid index.
    // Optimization: Check if the first element is already valid. If so, do nothing.
    if (this._eventHistory[0].tick > cutoffTick) return;

    let cutoffIndex = 0;
    // Simple scan optimization: if we have lots of events, we assume many are old.
    // However, binary search might be overkill for typical buffer sizes (5000). 
    // Linear scan until we find the break point is cleaner than filter().
    for (let i = 0; i < this._eventHistory.length; i++) {
        if (this._eventHistory[i].tick > cutoffTick) {
            cutoffIndex = i;
            break;
        }
    }
    
    if (cutoffIndex > 0) {
        const trimmedCount = cutoffIndex;
        // Slice is faster than filter for bulk removal at start
        this._eventHistory = this._eventHistory.slice(cutoffIndex);
        
        if (this.debug) {
            console.log(`[EventBus] Trimmed ${trimmedCount} old events from history (keeping last ${this._maxHistoryTicks} ticks)`);
        }
    }
  }

  /**
   * Registers an event listener.
   * @param {string} event - The event name
   * @param {Function} listener - The callback function
   */
  on(event, listener) {
    if (typeof event !== 'string' || !event) {
      console.warn('[EventBus] Invalid event name in on()');
      return;
    }
    if (typeof listener !== 'function') {
      console.warn('[EventBus] Listener must be a function');
      return;
    }
    
    if (this.debug) {
      console.log(`[EventBus:ON:${this._getNamespace(event)}] New listener registered for '${event}'`);
    }
    this._emitter.on(event, listener);
  }

  /**
   * Registers a one-time event listener.
   * @param {string} event - The event name
   * @param {Function} listener - The callback function
   */
  once(event, listener) {
    if (typeof event !== 'string' || !event) {
      console.warn('[EventBus] Invalid event name in once()');
      return;
    }
    if (typeof listener !== 'function') {
      console.warn('[EventBus] Listener must be a function');
      return;
    }
    
    if (this.debug) {
      console.log(`[EventBus:ONCE:${this._getNamespace(event)}] New one-time listener registered for '${event}'`);
    }
    this._emitter.once(event, listener);
  }

  /**
   * Removes an event listener.
   * @param {string} event - The event name
   * @param {Function} listener - The callback function to remove
   */
  off(event, listener) {
    if (this.debug) {
      console.log(`[EventBus:OFF:${this._getNamespace(event)}] Listener removed for '${event}'`);
    }
    this._emitter.off(event, listener);
  }

  /**
   * Queues an event to be processed at the end of the tick.
   * [FIX 1] Removed Closure Memory Leak: Stores args array directly.
   * @param {string} event - The event name (e.g., "agent:moved").
   * @param {'high'|'medium'|'low'} priority - The priority channel.
   * @param {...any} args - Arguments to pass to the listeners.
   */
  queue(event, priority = 'medium', ...args) {
    if (typeof event !== 'string' || !event) {
      console.warn('[EventBus] Invalid event name in queue()');
      return;
    }
    
    // Log to profiler/history *when queued*
    this._logEvent(event, args);

    if (this._batchableEvents.has(event)) {
      // --- Handle Batched Event ---
      if (!this._batchQueues.has(event)) {
        this._batchQueues.set(event, []);
      }
      this._batchQueues.get(event).push(args);
      if (this.debug) {
        console.log(`[EventBus:BATCH:${this._getNamespace(event)}] Batched '${event}'`);
      }
    } else {
      // --- Handle Prioritized Event ---
      if (this._queues[priority]) {
        // [FIX 1] Store object with direct args array, no closure.
        this._queues[priority].push({ event, args });
        if (this.debug) {
          console.log(`[EventBus:QUEUE:${this._getNamespace(event)}] Queued '${event}' with priority ${priority}`);
        }
      } else {
        console.warn(`[EventBus:WARN] Unknown priority '${priority}' for event '${event}'. Defaulting to 'medium'.`);
        this._queues.medium.push({ event, args });
      }
    }
  }

  /**
   * Synchronous, blocking emit. Bypasses queue.
   * Use ONLY for critical system events like 'system:shutdown'.
   * @param {string} event - The event name.
   * @param  {...any} args - Arguments to pass to the listeners.
   */
  emitNow(event, ...args) {
    if (typeof event !== 'string' || !event) {
      console.warn('[EventBus] Invalid event name in emitNow()');
      return;
    }
    
    // Log to profiler/history *when emitted*
    this._logEvent(event, args);

    if (this.debug) {
      console.log(`[EventBus:EMIT-NOW:${this._getNamespace(event)}] Firing '${event}' immediately.`);
    }
    
    try {
      this._emitter.emit(event, ...args);
    } catch (error) {
      console.error(`[EventBus] Error in listener for '${event}':`, error);
      // Don't throw - we want to continue processing other events
    }
  }
  
  /**
   * COMPATIBILITY ALIAS
   * Aliases emit() to emitNow() to prevent crashes if standard API is used.
   */
  emit(event, ...args) {
      return this.emitNow(event, ...args);
  }

  /**
   * Processes all queued events.
   * This should be called ONCE per tick by the main simulation loop.
   * Returns a promise to support async operations during shutdown.
   */
  async processQueues() {
    const startTime = Date.now();
    let eventsProcessed = 0;
    let batchesProcessed = 0;

    if (this.debug && (this._batchQueues.size > 0 || this._queues.high.length > 0 || this._queues.medium.length > 0 || this._queues.low.length > 0)) {
      console.log(`[EventBus:PROCESS] Processing all queues...`);
    }

    try {
      // --- 1. Process Batched Events ---
      // [FIX 4] Move clear() to finally block (or ensure execution)
      // We iterate a snapshot of keys/values to handle batch processing safely
      if (this._batchQueues.size > 0) {
        for (const [event, payloads] of this._batchQueues) {
            if (payloads.length > 0) {
            const batchEventName = `${event}_batch`;
            if (this.debug) {
                console.log(`[EventBus:PROCESS:BATCH] Firing '${batchEventName}' with ${payloads.length} items.`);
            }
            
            try {
                this._emitter.emit(batchEventName, payloads);
                batchesProcessed++;
                eventsProcessed += payloads.length;
            } catch (error) {
                console.error(`[EventBus] Error in batch listener for '${batchEventName}':`, error);
            }
            }
        }
        // [FIX 4] Clear executed immediately after loop to prevent double processing
        // even if individual emits failed, we consider them "processed" (consumed).
        this._batchQueues.clear();
      }

      // --- 2. Process Priority Queues (High > Medium > Low) ---
      const priorities = ['high', 'medium', 'low'];
      for (const priority of priorities) {
        const queue = this._queues[priority];
        // Optimization: Check length before iterating
        if (queue.length > 0) {
          if (this.debug) {
            console.log(`[EventBus:PROCESS] Firing ${queue.length} '${priority}' priority events.`);
          }
          
          // Process current snapshot of queue
          // We clear the main queue reference immediately so new events queued *during* processing
          // end up in the next tick's queue (preventing infinite loops)
          const currentBatch = [...queue];
          this._queues[priority] = [];

          for (const { event, args } of currentBatch) {
            try {
              // [FIX 1] Args are now array, spread them directly
              this._emitter.emit(event, ...args);
              eventsProcessed++;
            } catch (error) {
              console.error(`[EventBus] Error in listener for '${event}':`, error);
            }
          }
        }
      }
      
      // --- 3. Small delay to ensure async listeners complete ---
      // This is especially important during shutdown
      if (eventsProcessed > 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
      
    } catch (error) {
      console.error('[EventBus] Critical error during queue processing:', error);
      // Ensure queues are cleared even in catastrophic failure to prevent "poison pill" events from sticking
      this._batchQueues.clear();
      this._queues.high = [];
      this._queues.medium = [];
      this._queues.low = [];
    }

    // --- Update Performance Metrics ---
    const duration = Date.now() - startTime;
    this._performanceMetrics.totalEventsProcessed += eventsProcessed;
    this._performanceMetrics.totalBatchesProcessed += batchesProcessed;
    this._performanceMetrics.lastProcessDuration = duration;

    if (this.debug && duration > 50) {
      console.warn(`[EventBus] Queue processing took ${duration}ms (${eventsProcessed} events)`);
    }
  }

  // --- Phase 3: Public API ---

  /**
   * Returns the event history.
   * @param {number} [limit] - Optional limit on number of events to return
   * @returns {Array} Array of event records
   */
  getEventHistory(limit) {
    if (limit && typeof limit === 'number' && limit > 0) {
      return this._eventHistory.slice(-limit);
    }
    return [...this._eventHistory]; // Return a copy to prevent external mutation
  }

  /**
   * Returns events for a specific tick range.
   * @param {number} startTick - Starting tick (inclusive)
   * @param {number} endTick - Ending tick (inclusive)
   * @returns {Array} Filtered event records
   */
  getEventHistoryByTick(startTick, endTick) {
    return this._eventHistory.filter(e => 
      e.tick >= startTick && e.tick <= endTick
    );
  }

  /**
   * Returns the event profile (counts by event type).
   * @returns {Object} Map of event names to counts
   */
  getEventProfile() {
    return Object.fromEntries(this._eventProfiler);
  }

  /**
   * Returns performance metrics.
   * @returns {Object} Performance statistics
   */
  getPerformanceMetrics() {
    return { ...this._performanceMetrics };
  }

  /**
   * Pauses history recording.
   */
  pauseHistory() {
    this._historyPaused = true;
    if (this.debug) {
      console.log('[EventBus] History recording paused');
    }
  }

  /**
   * Resumes history recording.
   */
  resumeHistory() {
    this._historyPaused = false;
    if (this.debug) {
      console.log('[EventBus] History recording resumed');
    }
  }

  /**
   * Clears all history and profiler data.
   */
  clearHistory() {
    this._eventHistory = [];
    this._eventProfiler.clear();
    this._performanceMetrics = {
      totalEventsProcessed: 0,
      totalBatchesProcessed: 0,
      lastProcessDuration: 0,
    };
    if (this.debug) {
      console.log('[EventBus] History and profiler cleared');
    }
  }

  /**
   * Manually triggers history trimming (useful for testing).
   */
  trimHistory() {
    this._trimHistory();
  }

  /**
   * Returns current statistics about the event bus state.
   * @returns {Object} Current state statistics
   */
  getStats() {
    return {
      currentTick: this._currentTick,
      historySize: this._eventHistory.length,
      queuedHigh: this._queues.high.length,
      queuedMedium: this._queues.medium.length,
      queuedLow: this._queues.low.length,
      batchQueues: this._batchQueues.size,
      uniqueEventTypes: this._eventProfiler.size,
      ...this._performanceMetrics,
    };
  }
  
  _getNamespace(eventName) {
      return eventName.split(':')[0] || 'global';
  }
}

// Export a single, shared instance
const eventBus = new EventBus({
  maxHistoryEvents: 5000,  // Max events in memory
  maxHistoryTicks: 1000,   // Keep last 1000 ticks of history
});

export default eventBus;