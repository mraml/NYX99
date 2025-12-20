import fs from 'fs';
import { promises as fsPromises } from 'fs'; // Use fs/promises for async I/O
import yaml from 'js-yaml';
import path from 'path';
import eventBus from '../engine/eventBus.js';

/**
 * dataLoader.js
 *
 * Singleton for loading all YAML data at startup.
 * (MODIFIED v9.0: Converted synchronous file reads to asynchronous using fs/promises)
 */

// --- NEW: Maps to be populated from YAML ---
export const ACTIVITIES_MAP = {};
export const DISCOVERABLE_ACTIVITIES = {};
// --- NEW: Activity costs map, populated from YAML ---
export const ACTIVITY_COSTS = {};
// --- NEW: Dynamic World Modifiers ---
export const DYNAMIC_AFFORDANCE_MODIFIERS = {};
// --- NEW: Item Catalog ---
export const ITEM_CATALOG = {};
// --- NEW: Crowd Schedules ---
export const CROWD_SCHEDULES = {};
// --- END NEW ---


class DataLoader {
  constructor() {
    this.demographics = null;
    this.worldData = null; // This will be an aggregate of the new YAML files
    this.activities = null;
    this.locationGraph = null;
  }

  log(message, level = 'low') {
    // --- MODIFICATION: Use queue with level ---
    const event = level === 'error' ? 'log:error' : 'log:info';
    eventBus.queue(event, level, message);
  }

  // --- MODIFICATION: Use emitNow for critical startup errors ---
  logCritical(message) {
    console.error(message);
    eventBus.emitNow('log:error', message);
  }
  // --- END MODIFICATION ---

  /**
   * @description Loads and parses a YAML file asynchronously.
   * @param {string} filename - The name of the YAML file.
   * @returns {Promise<object | null>} The parsed YAML content.
   */
  async loadYaml(filename) {
    try {
      // --- ASYNC FIX: Use fs.promises.readFile ---
      const rawPath = path.join(process.cwd(), 'data', filename);
      const fileContents = await fsPromises.readFile(rawPath, 'utf8');
      return yaml.load(fileContents);
    } catch (e) {
      this.logCritical(`[DataLoader] CRITICAL: FAILED to load YAML: ${filename}`);
      this.logCritical(`[DataLoader] Error: ${e.message}`);
      // Note: We return null here, allowing Promise.all to continue but indicating failure
      return null; 
    }
  }
  
  // --- NEW: Process activities YAML into usable maps ---
  processActivities(activitiesData) {
    if (!activitiesData || !activitiesData.activities) {
      this.log('[DataLoader] activities.yaml is empty or malformed. No activities loaded.', 'error');
      return;
    }

    for (const activity of activitiesData.activities) {
      // 1. Populate ACTIVITIES_MAP
      ACTIVITIES_MAP[activity.name] = activity;

      // 2. Populate DISCOVERABLE_ACTIVITIES map
      if (activity.location_types) {
        for (const locType of activity.location_types) {
          if (!DISCOVERABLE_ACTIVITIES[locType]) {
            DISCOVERABLE_ACTIVITIES[locType] = [];
          }
          DISCOVERABLE_ACTIVITIES[locType].push(activity.name);
          
          // Add to 'any' as well
          if (locType !== 'any') {
             if (!DISCOVERABLE_ACTIVITIES['any']) {
                DISCOVERABLE_ACTIVITIES['any'] = [];
             }
             DISCOVERABLE_ACTIVITIES['any'].push(activity.name);
          }
        }
      }
    }
    
    const totalActivities = Object.keys(ACTIVITIES_MAP).length;
    const totalLocationTypes = Object.keys(DISCOVERABLE_ACTIVITIES).length;
    this.log(`[DataLoader] Processed ${totalActivities} activities across ${totalLocationTypes} location types.`);
  }
  // --- END NEW ---

  // --- NEW: Process world data YAML into usable maps ---
  _processWorldData(worldData) {
    if (!worldData || !worldData.typical_prices) {
        this.log('[DataLoader] economics.yaml is missing typical_prices. Activity costs will be defaults.', 'warn');
        // Continue processing dynamic modifiers even if prices are missing
    }

    // 1. Process Typical Prices
    const typicalPrices = worldData?.typical_prices || [];
    const priceMap = typicalPrices.reduce((acc, item) => {
        if (Array.isArray(item.price)) {
            acc[item.item] = (item.price[0] + item.price[1]) / 2;
        } else {
            acc[item.item] = item.price;
        }
        return acc;
    }, {});

    // Populate the exported ACTIVITY_COSTS object
    ACTIVITY_COSTS['eating meal'] = priceMap['Casual restaurant meal'] || 18;
    ACTIVITY_COSTS['eating breakfast'] = priceMap['Diner breakfast'] || 6.5;
    ACTIVITY_COSTS['get coffee'] = priceMap['Coffee (Starbucks)'] || 3.25;
    ACTIVITY_COSTS['getting snacks'] = priceMap['Hot dog from cart'] || 1.5;
    ACTIVITY_COSTS['watch movie'] = priceMap['Movie ticket'] || 9.25;
    ACTIVITY_COSTS['renting video'] = priceMap['Video rental'] || 3.5;
    ACTIVITY_COSTS['browse books'] = 0;
    ACTIVITY_COSTS['play arcade game'] = 1.0;
    ACTIVITY_COSTS['playing pool'] = 1.5;
    ACTIVITY_COSTS['playing darts'] = 0;
    ACTIVITY_COSTS['attending concert'] = priceMap['Concert ticket (club)'] || 15;
    ACTIVITY_COSTS['go to venue'] = priceMap['Concert ticket (club)'] || 15;
    ACTIVITY_COSTS['attending theater'] = priceMap['Broadway show'] || 80;
    ACTIVITY_COSTS['getting haircut'] = priceMap['Haircut (basic)'] || 15;
    ACTIVITY_COSTS['default_eat'] = priceMap['Deli sandwich'] || 5;
    ACTIVITY_COSTS['shopping'] = priceMap['Deli sandwich'] || 5;
    ACTIVITY_COSTS['maintenance'] = priceMap['Deli sandwich'] || 25;
    ACTIVITY_COSTS['subway_fare'] = priceMap['Subway token'] || 1.50;
    
    this.log(`[DataLoader] Processed ${typicalPrices.length} prices into ACTIVITY_COSTS map.`);
    
    // 2. Process Dynamic Affordance Modifiers
    if (worldData?.dynamic_affordance_modifiers) {
        // Deep copy the modifiers array into the exported constant
        Object.assign(DYNAMIC_AFFORDANCE_MODIFIERS, {
            modifiers: [...worldData.dynamic_affordance_modifiers]
        });
        this.log(`[DataLoader] Loaded ${DYNAMIC_AFFORDANCE_MODIFIERS.modifiers.length} dynamic affordance modifiers.`);
    } else {
        this.log('[DataLoader] dynamic_affordance_modifiers section (events.yaml) is missing.', 'warn');
        Object.assign(DYNAMIC_AFFORDANCE_MODIFIERS, { modifiers: [] });
    }

    // 3. Populate ITEM_CATALOG (New Feature)
    // NOTE: This array would typically come from a separate YAML, but we'll mock it here
    // based on common world data elements to keep file count down.
    const rawItems = [
        // Standard Food (Consumable)
        { id: 'canned_soup', name: 'Canned Soup', type: 'food', cost: 3.00, energy_boost: 10, hunger_reduction: 30, uses: 1, tags: ['kitchen'] },
        { id: 'tv_dinner', name: 'TV Dinner', type: 'food', cost: 5.00, energy_boost: 5, hunger_reduction: 40, uses: 1, tags: ['microwave', 'tv'] },
        { id: 'protein_bar', name: 'Protein Bar', type: 'food', cost: 2.50, energy_boost: 15, hunger_reduction: 15, uses: 1, tags: ['snack'] },
        // Hobby/Skill Items (Tool/Durable)
        { id: 'programming_book', name: 'Y2K Programming Book', type: 'tool', cost: 45.00, skill_mod: 'programming', skill_boost: 0.5, uses: Infinity, tags: ['intellectual'] },
        { id: 'art_supplies', name: 'Sketchpad & Pencils', type: 'tool', cost: 15.00, skill_mod: 'art', skill_boost: 0.3, uses: Infinity, tags: ['creative'] },
        { id: 'workout_tapes', name: 'Workout VHS Tapes', type: 'tool', cost: 20.00, skill_mod: 'sports', skill_boost: 0.4, uses: Infinity, tags: ['active'] },
        // Luxury/Gift Items (Durable/Social)
        { id: 'nice_watch', name: 'Nice Watch', type: 'apparel', cost: 150.00, social_mod: 0.2, uses: Infinity, tags: ['fashion', 'status'] },
        { id: 'cheap_jewelry', name: 'Cheap Necklace', type: 'gift', cost: 10.00, social_mod: 0.05, uses: 1, tags: ['gift', 'low_value'] },
        { id: 'bouquet', name: 'Bouquet of Flowers', type: 'gift', cost: 30.00, social_mod: 0.15, uses: 1, tags: ['gift', 'date'] },
        // Misc Item
        { id: 'energy_drink', name: 'Energy Drink', type: 'consumable', cost: 3.50, energy_boost: 30, uses: 1, tags: ['caffeine'] },
    ];
    
    rawItems.forEach(item => {
        ITEM_CATALOG[item.id] = item;
    });

    this.log(`[DataLoader] Loaded ${Object.keys(ITEM_CATALOG).length} unique items into the ITEM_CATALOG.`);
  }
  // --- END NEW ---

  async loadAllData() {
    this.log('[DataLoader] Starting asynchronous data load...');
    
    // Concurrently load all YAML files
    const [
      demographicsData,
      locationsData,
      economicsData,
      cultureData,
      eventsData,
      sensoryData,
      locationGraphData,
      activitiesData,
      crowdData
    ] = await Promise.all([
      this.loadYaml('demographics.yaml'),
      this.loadYaml('locations.yaml'),
      this.loadYaml('economics.yaml'),
      this.loadYaml('culture.yaml'),
      this.loadYaml('events.yaml'),
      this.loadYaml('sensory.yaml'),
      this.loadYaml('location_graph.yaml'),
      this.loadYaml('activities.yaml'),
      this.loadYaml('crowd_schedules.yaml')
    ]);
    
    // Assign directly to instance properties
    this.demographics = demographicsData;
    this.activities = activitiesData;
    this.locationGraph = locationGraphData;

    // --- REFACTOR: Aggregate world data and check for load failures ---
    const allCriticalDataLoaded = this.demographics && locationsData && economicsData && cultureData && eventsData && sensoryData && this.activities && this.locationGraph && crowdData;

    if (!allCriticalDataLoaded) {
      this.logCritical('[DataLoader] One or more critical YAML data files failed to load. Aborting.');
      throw new Error('Critical YAML data file failed to load.');
    }
    
    // Aggregate all split files into the single worldData object
    this.worldData = {
        ...locationsData,
        ...economicsData,
        ...cultureData,
        ...eventsData,
        ...sensoryData
    };
    this.log('[DataLoader] Aggregated all world data YAMLs.');
    // --- END REFACTOR ---
    
    this.log('[DataLoader] Processing activities.yaml...', 'low');
    this.processActivities(this.activities);

    // --- NEW: Process world data ---
    this.log('[DataLoader] Processing aggregated world data for costs and dynamics...', 'low');
    this._processWorldData(this.worldData);
    // --- END NEW ---

    // --- NEW: Process crowd schedule data ---
    if (crowdData?.schedules) {
        Object.assign(CROWD_SCHEDULES, crowdData.schedules);
        this.log(`[DataLoader] Loaded ${Object.keys(CROWD_SCHEDULES).length} crowd schedules.`);
    } else {
        this.log('[DataLoader] crowd_schedules.yaml is missing a "schedules" root key.', 'warn');
    }
    // --- END NEW ---
    
    this.log('[DataLoader] All YAML data loaded and processed successfully.', 'medium');
  }
}

// Export a singleton instance
export const dataLoader = new DataLoader();