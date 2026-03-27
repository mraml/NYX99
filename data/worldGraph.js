import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';
import eventBus from '../engine/eventBus.js';
import {
    dataLoader,
    ACTIVITY_COSTS,
    DYNAMIC_AFFORDANCE_MODIFIERS,
    CROWD_SCHEDULES
} from './dataLoader.js';
import {
  MINUTES_PER_TICK
} from './config.js';
import { GAME_BALANCE } from './balance.js';

/**
 * worldGraph.js
 *
 * ARCHITECT NOTES:
 * - v14.0: Aggressively rebalanced affordances to force agents out of homes.
 * - Optimized cache keys for large graph traversals.
 * - Integrated flavor text from dataLoader for dynamic node description.
 */
class WorldGraph {
  constructor() {
    this.nodes = {};
    this.edges = {};
    this.nodesByType = {};
    
    this.currentWorldEvents = [];
    this.currentHour = 0;
    this.currentDay = 0;
    this.currentWorldTime = new Date();
    this.currentWeather = null;
    this.currentOccupancy = new Map();
    
    this.localEvents = new Map(); 
    this.nodeInventory = new Map(); 
    
    // Performance: Increased cache size for pathfinding in large Manhattan/Brooklyn graphs
    this._pathCache = new Map(); 
    this._pathCacheAccess = new Map(); 
    this._travelCostCache = new Map(); 
    this._cacheMaxSize = 5000; 
    
    this._queryCache = new Map();
    this._affordanceStateCache = new Map(); 
    this._worldStateHash = 0;
  }

  init() {
    this._loadGraph();
  }

  log(message, level = 'low') {
    const event = level === 'error' ? 'log:error' : 'log:system';
    eventBus.queue(event, level, `[WorldGraph] ${message}`);
  }

  logCritical(message) {
    console.error(`[WorldGraph] ${message}`);
    eventBus.emitNow('log:error', `[WorldGraph] ${message}`);
  }

  _loadGraph() {
    const graphData = dataLoader.locationGraph;
    const worldData = dataLoader.worldData || {};
    const locationsData = dataLoader.locations || {}; // Sourced from locations.yaml

    if (!graphData || !graphData.nodes || !graphData.edges) {
      this.logCritical('CRITICAL: location_graph.yaml data is missing or malformed.');
      process.exit(1);
    }

    for (const node of graphData.nodes) {
      this.nodes[node.key] = node;
      this.edges[node.key] = [];

      node.prosperity = 50; 
      this.nodeInventory.set(node.key, 100); 
      this.localEvents.set(node.key, []);

      // ENRICHMENT: Use dataLoader consistent locations more aggressively
      const nodeType = node.type;
      
      // Try worldData first, then fallback to locations.yaml consistent_locations
      const nameList = worldData.consistent_locations?.[nodeType] || 
                       locationsData.consistent_locations?.[nodeType] || [];
      
      if (nameList.length > 0) {
          // Deterministic random based on node key to ensure names stick across reloads if key is constant
          const hash = node.key.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
          node.name = nameList[hash % nameList.length];
      } else {
          // Fallback formatter
          const fallbackName = `${node.borough} ${node.type}`
              .replace(/_/g, ' ')
              .replace(/\b\w/g, l => l.toUpperCase());
          node.name = fallbackName;
      }

      if (!this.nodesByType[node.type]) {
        this.nodesByType[node.type] = [];
      }
      this.nodesByType[node.type].push(node);

      node.capacity = node.capacity || 10;
      if (node.capacity <= 0) node.capacity = 1;

      node.isOutdoors = (node.type === 'street' || node.type === 'park' || node.type === 'alley');

      // Set noise levels
      let baseNoise = 0.2;
      if (node.isOutdoors) baseNoise = 0.5;
      if (node.type === 'bar' || node.type === 'venue') baseNoise = 0.9;
      if (node.type === 'library' || node.type === 'museum') baseNoise = 0.1;
      node.baseNoise = baseNoise;

      // Business logic
      const businessTypes = ['office', 'bar', 'restaurant', 'store', 'venue', 'gym'];
      if (businessTypes.includes(node.type)) {
        node.is_business = true;
        node.treasury = Math.floor(Math.random() * 10000) + 5000;
        node.level = 1;
        node.productivity = (node.capacity || 10) * 0.5;
        node.upkeep = node.productivity * 0.2;
        node.employee_ids = [];
      }

      if (node.type === 'home') {
          node.condition = Math.floor(Math.random() * 20) + 80;
          node.rent_cost = 500; 
      }

      node.crowd_schedule = CROWD_SCHEDULES[node.type] || [];
      node.operating_hours = [0, 24]; // Default to always open, specific types override in getDynamic
      
      // REBALANCE: Generate updated affordances
      node.base_affordances = this._generateBaseAffordances(node.type);
      node.affordances = node.base_affordances;
    }

    for (const edge of graphData.edges) {
      if (this.nodes[edge.from] && this.nodes[edge.to]) {
        // Default travel time if not specified
        const travel_ticks = edge.travel_ticks || edge.base_time || 2;
        this.edges[edge.from].push({ to: edge.to, travel_ticks: travel_ticks });
        this.edges[edge.to].push({ to: edge.from, travel_ticks: travel_ticks });
      }
    }

    this.log(`Successfully loaded graph with ${Object.keys(this.nodes).length} nodes.`, 'medium');
  }

  /**
   * REBALANCED AFFORDANCES
   * Home is now significantly worse than public venues for Recreation and Eating.
   * This forces the FSM to choose travel to maintain high mood/energy stats.
   */
  _generateBaseAffordances(type) {
      switch (type) {
        case 'home': return [
            { action: 'fsm_sleeping', quality: 1.0 }, // Home is best for sleep
            { action: 'fsm_eating', quality: 0.5 },   // Home cooking is "meh" (was 0.7)
            { action: 'fsm_recreation', quality: 0.4 }, // Home is boring (was 0.8)
            { action: 'fsm_maintenance', quality: 1.0 },
            { action: 'fsm_socializing', quality: 0.2 } // Hard to socialize alone (was 0.5)
        ];
        case 'office': return [{ action: 'fsm_working_office', quality: 1.0 }];
        case 'school': return [{ action: 'fsm_working_teacher', quality: 1.0 }];
        case 'bar': return [
            { action: 'fsm_socializing', quality: 1.5 }, // Bars are SUPER social (was 1.0)
            { action: 'fsm_eating', quality: 0.4 },
            { action: 'fsm_recreation', quality: 0.9 }
        ];
        case 'restaurant': return [
            { action: 'fsm_eating', quality: 1.0 }, // Best for food
            { action: 'fsm_socializing', quality: 0.8 },
            { action: 'fsm_recreation', quality: 0.3 }
        ];
        case 'store': return [{ action: 'fsm_shopping', quality: 1.0 }];
        case 'park': return [
            { action: 'fsm_recreation', quality: 1.2 }, // Parks are high value fun (was 0.9)
            { action: 'fsm_socializing', quality: 0.7 }
        ];
        case 'library': return [
            { action: 'fsm_recreation', quality: 1.1 }, // Reading is fun
            { action: 'fsm_working_student', quality: 1.0 }
        ];
        case 'gym': return [
            { action: 'fsm_maintenance', quality: 1.2 }, // Better than home maintenance
            { action: 'fsm_recreation', quality: 0.6 }
        ];
        case 'street': return [
            { action: 'fsm_recreation', quality: 0.2 }, // Walking around is slightly fun
            { action: 'fsm_socializing', quality: 0.1 }
        ];
        default: return [{ action: 'fsm_recreation', quality: 0.1 }];
      }
  }

  consumeStock(nodeKey, amount = 5) {
      const current = this.nodeInventory.get(nodeKey) || 0;
      if (current <= 0) return false; 
      
      this.nodeInventory.set(nodeKey, Math.max(0, current - amount));
      
      const node = this.nodes[nodeKey];
      if (node) node.prosperity = Math.min(100, (node.prosperity || 50) + 0.1);
      
      return true;
  }

  addLocalEvent(nodeKey, type, effect, durationMinutes) {
      if (!this.localEvents.has(nodeKey)) this.localEvents.set(nodeKey, []);
      
      const expiresAt = new Date(this.currentWorldTime.getTime() + durationMinutes * 60000);
      this.localEvents.get(nodeKey).push({ type, effect, expiresAt });
      
      this._worldStateHash = this._generateWorldStateHash(); 
  }

  _cleanExpiredLocalEvents() {
      const now = this.currentWorldTime.getTime();
      for (const [key, events] of this.localEvents) {
          const valid = events.filter(e => e.expiresAt.getTime() > now);
          if (valid.length !== events.length) {
              this.localEvents.set(key, valid);
          }
      }
  }

  updateDynamicState(worldTime, worldEvents, occupancyMap, currentWeather) {
    const oldHash = this._worldStateHash;
    
    this.currentWorldTime = worldTime;
    this.currentHour = worldTime.getHours();
    this.currentDay = worldTime.getDay();
    this.currentOccupancy = occupancyMap || new Map();
    this.currentWeather = currentWeather;
    
    // Restock at 4 AM
    if (this.currentHour === 4 && worldTime.getMinutes() === 0) {
        for (const key of this.nodeInventory.keys()) {
            this.nodeInventory.set(key, 100);
        }
        // Garbage collect path cache periodically
        if (this._pathCache.size > this._cacheMaxSize) {
            this._pathCache.clear();
            this._pathCacheAccess.clear();
        }
        this.log('All stores restocked & caches cleaned.', 'low');
    }

    this._cleanExpiredLocalEvents();

    const newHash = this._generateWorldStateHash();
    
    if (newHash !== oldHash) {
      this._worldStateHash = newHash;
      this._queryCache.clear();
      this._affordanceStateCache.clear();
      // Note: We do NOT clear path cache here, as geometry rarely changes based on state hash
    }
    
    this.currentWorldEvents = worldEvents;
  }

  _generateWorldStateHash() {
    let localEventCount = 0;
    for (const evts of this.localEvents.values()) localEventCount += evts.length;
    
    const eventTypes = this.currentWorldEvents.map(e => e.type).sort().join(',');
    const weatherKey = this.currentWeather?.weather || 'Clear';

    // We don't hash exact occupancy for affordances unless it crosses thresholds, 
    // effectively managed inside getDynamicAffordances to prevent thrashing.
    return `${this.currentHour}:${this.currentDay}:${eventTypes}:${weatherKey}:${localEventCount}`;
  }

  getExpectedCrowdProfile(node) {
    if (!node || !node.crowd_schedule || node.crowd_schedule.length === 0) {
        return { demographics: ['general_public'], density: 0.3, reason: 'default_open' };
    }

    const currentHour = this.currentHour;

    for (const schedule of node.crowd_schedule) {
        const [start, end] = schedule.hours;

        if (start > end) {
            // Overnight (e.g. 22 to 04)
            if (currentHour >= start || currentHour < end) {
                return {
                    demographics: schedule.demographics,
                    density: schedule.density,
                    reason: schedule.reason || 'scheduled'
                };
            }
        } else {
            // Normal (e.g. 09 to 17)
            if (currentHour >= start && currentHour < end) {
                return {
                    demographics: schedule.demographics,
                    density: schedule.density,
                    reason: schedule.reason || 'scheduled'
                };
            }
        }
    }
    return { demographics: ['general_public'], density: 0.1, reason: 'default_off_hours' };
  }

  getDynamicAffordances(node, currentHour, currentDay, worldEvents) {
    if (!node || !node.base_affordances) return { open: false, affordances: [], reason: 'No Data' };
    
    if (currentHour === undefined || currentHour === null) {
        currentHour = this.currentHour || 12;
    }

    const currentOccupancy = this.currentOccupancy.get(node.key) || 0;
    
    // Round occupancy to nearest 5 to prevent cache thrashing on every agent entry/exit
    const occupancyBucket = Math.floor(currentOccupancy / 5) * 5; 
    const cacheKey = `${node.key}:${this._worldStateHash}:${occupancyBucket}`;
    
    if (this._affordanceStateCache.has(cacheKey)) {
      return this._affordanceStateCache.get(cacheKey);
    }

    let isCurrentlyOpen = this._isStaticallyOpen(node, currentHour);
    let currentAffordances = node.base_affordances.map(aff => ({ ...aff }));
    let closeReason = null;

    // Stock check for stores
    if (node.type === 'store') {
        const stock = this.nodeInventory.get(node.key) ?? 100;
        if (stock <= 5) {
            currentAffordances = [];
            isCurrentlyOpen = false;
            closeReason = "Sold Out";
        } else if (stock < 20) {
            currentAffordances.forEach(aff => aff.quality *= 0.5);
        }
    }

    // Weather impact
    if (isCurrentlyOpen && node.isOutdoors) {
        const weatherType = this.currentWeather?.weather || 'Clear';
        if (weatherType.includes('Rain') || weatherType.includes('Snow')) {
            currentAffordances.forEach(aff => aff.quality *= 0.4);
        }
    }

    // Crowding impact
    if (isCurrentlyOpen && currentAffordances.length > 0) {
        const crowdFactor = currentOccupancy / node.capacity;
        if (crowdFactor > 0.9) {
            currentAffordances.forEach(aff => {
                // Crowding hurts relaxation but helps socializing
                if (aff.action !== 'fsm_socializing') aff.quality *= 0.5; 
                else aff.quality *= 1.3; 
            });
        }
    }

    const result = isCurrentlyOpen
      ? { open: true, affordances: currentAffordances, reason: null }
      : { open: false, affordances: [], reason: closeReason };
    
    this._affordanceStateCache.set(cacheKey, result);
    return result;
  }

  _isStaticallyOpen(node, hour) {
    // 24/7 locations
    if (['home', 'park', 'street', 'subway'].includes(node.type)) return true;
    
    // Business hours
    if (!node.operating_hours) return true;
    
    // Simulating "Closed at night" for businesses if not specified
    if (node.is_business && !node.operating_hours) {
        return (hour >= 8 && hour < 22);
    }

    const [start, end] = node.operating_hours;
    if (start > end) return (hour >= start || hour < end);
    return (hour >= start && hour < end);
  }

  isLocationOpen(node) {
      if (!node) return false;
      return this.getDynamicAffordances(node, this.currentHour, this.currentDay, this.currentWorldEvents).open;
  }

  getLocationAffordances(node) {
      if (!node) return [];
      return this.getDynamicAffordances(node, this.currentHour, this.currentDay, this.currentWorldEvents).affordances;
  }
  
  findPath(startKey, endKey) {
    if (!this.nodes[startKey] || !this.nodes[endKey]) return null;
    if (startKey === endKey) return [startKey];

    const cacheKey = `${startKey}->${endKey}`;
    if (this._pathCache.has(cacheKey)) {
      this._pathCacheAccess.set(cacheKey, Date.now());
      return this._pathCache.get(cacheKey);
    }

    const queue = [[startKey]];
    const visited = new Set([startKey]);
    
    // Optimized BFS
    while (queue.length > 0) {
      const path = queue.shift();
      const nodeKey = path[path.length - 1];
      if (nodeKey === endKey) {
        this._pathCache.set(cacheKey, path);
        this._pathCacheAccess.set(cacheKey, Date.now());
        return path;
      }
      if (this.edges[nodeKey]) {
        for (const edge of this.edges[nodeKey]) {
            if (!visited.has(edge.to)) {
                visited.add(edge.to);
                queue.push([...path, edge.to]);
            }
        }
      }
    }
    this._pathCache.set(cacheKey, null);
    return null;
  }

  getTravelCost(fromId, toId) {
      const path = this.findPath(fromId, toId);
      if (!path) return Infinity;
      const weatherPenalty = (this.currentWeather?.weather.includes('Rain')) ? 1.5 : 1.0;
      // Base cost is path length * 2 minutes per node (assumed)
      return (path.length - 1) * 2.0 * weatherPenalty; 
  }

  getDistance(fromId, toId) {
      return this.getTravelCost(fromId, toId);
  }

  findRandomLocationByType(type) {
    if (this.nodesByType[type] && this.nodesByType[type].length > 0) {
      // Filter out locations that are at or over capacity
      const availableNodes = this.nodesByType[type].filter(node => {
        const capacity = node.capacity || 10;
        const currentOccupancy = this.currentOccupancy?.get(node.key) || 0;
        return currentOccupancy < capacity;
      });
      if (availableNodes.length > 0) {
        return availableNodes[Math.floor(Math.random() * availableNodes.length)];
      }
    }
    return null;
  }
}

const worldGraphInstance = new WorldGraph();
export default worldGraphInstance;