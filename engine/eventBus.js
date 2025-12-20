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
 */
class EventBus {
  constructor(options = {}) {
    this._emitter = new EventEmitter();
    this.debug = false;
    this._currentTick = 0;

    // --- Phase 2: Priority Queues ---
    // Stores { event: string, argsFn: Function }
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
    // Trim every 100 ticks to avoid doing it too often
    if (tick - this._lastHistoryTrim >= 100) {
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
   * @param {Array|Function} argsOrFn - Array of arguments or a function that returns them.
   */
  _logEvent(event, argsOrFn) {
    // 1. Resolve arguments if they are a function (for lazy evaluation)
    const args = typeof argsOrFn === 'function' ? argsOrFn() : argsOrFn;
    
    // 2. Increment Profiler
    this._eventProfiler.set(event, (this._eventProfiler.get(event) || 0) + 1);

    // 3. Add to History
    if (this._historyPaused) return;

    this._eventHistory.push({
      tick: this._currentTick,
      timestamp: Date.now(),
      event,
      args: [...args], // Shallow copy args
    });

    // 4. Trim history if over max events (safety check)
    if (this._eventHistory.length > this._maxHistoryEvents) {
      this._eventHistory.shift(); // Remove oldest event
    }
  }

  /**
   * Trims old events from history based on tick age.
   * This prevents unbounded memory growth.
   * @private
   */
  _trimHistory() {
    if (this._eventHistory.length === 0) return;
    
    const cutoffTick = this._currentTick - this._maxHistoryTicks;
    const originalLength = this._eventHistory.length;
    
    // Filter out old events that are older than the cutoff tick
    this._eventHistory = this._eventHistory.filter(e => e.tick > cutoffTick);
    
    const trimmed = originalLength - this._eventHistory.length;
    if (this.debug && trimmed > 0) {
      console.log(`[EventBus] Trimmed ${trimmed} old events from history (keeping last ${this._maxHistoryTicks} ticks)`);
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
   * CRITICAL MODIFICATION: Stores arguments as a function (argsFn) to defer serialization.
   * @param {string} event - The event name (e.g., "agent:moved").
   * @param {'high'|'medium'|'low'} priority - The priority channel.
   * @param {...any} args - Arguments to pass to the listeners.
   */
  queue(event, priority = 'medium', ...args) {
    if (typeof event !== 'string' || !event) {
      console.warn('[EventBus] Invalid event name in queue()');
      return;
    }
    
    // Create a function closure to hold the arguments. This prevents V8 from compiling
    // the arguments immediately, thus deferring memory allocation and serialization.
    const argsFn = () => args;

    // Log to profiler/history *when queued* (must execute argsFn here)
    this._logEvent(event, argsFn);

    if (this._batchableEvents.has(event)) {
      // --- Handle Batched Event ---
      // Batched events must execute the argsFn to push concrete payloads
      if (!this._batchQueues.has(event)) {
        this._batchQueues.set(event, []);
      }
      this._batchQueues.get(event).push(argsFn());
      if (this.debug) {
        console.log(`[EventBus:BATCH:${this._getNamespace(event)}] Batched '${event}'`);
      }
    } else {
      // --- Handle Prioritized Event ---
      if (this._queues[priority]) {
        // Store the function closure instead of the arguments directly
        this._queues[priority].push({ event, argsFn });
        if (this.debug) {
          console.log(`[EventBus:QUEUE:${this._getNamespace(event)}] Queued '${event}' with priority ${priority}`);
        }
      } else {
        console.warn(`[EventBus:WARN] Unknown priority '${priority}' for event '${event}'. Defaulting to 'medium'.`);
        this._queues.medium.push({ event, argsFn });
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
      this._batchQueues.clear();

      // --- 2. Process Priority Queues (High > Medium > Low) ---
      const priorities = ['high', 'medium', 'low'];
      for (const priority of priorities) {
        const queue = this._queues[priority];
        if (queue.length > 0) {
          if (this.debug) {
            console.log(`[EventBus:PROCESS] Firing ${queue.length} '${priority}' priority events.`);
          }
          for (const { event, argsFn } of queue) {
            // CRITICAL MODIFICATION: Only execute the argsFn here, right before emitting.
            // This is the point of lazy evaluation.
            try {
              const args = argsFn();
              this._emitter.emit(event, ...args);
              eventsProcessed++;
            } catch (error) {
              console.error(`[EventBus] Error in listener for '${event}':`, error);
            }
          }
          this._queues[priority] = []; // Clear the queue
        }
      }
      
      // --- 3. Small delay to ensure async listeners complete ---
      // This is especially important during shutdown
      if (eventsProcessed > 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
      
    } catch (error) {
      console.error('[EventBus] Critical error during queue processing:', error);
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