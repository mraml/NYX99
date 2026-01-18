import fs from 'fs';
import { promises as fsPromises } from 'fs'; // Use fs/promises for async I/O
import yaml from 'js-yaml';
import path from 'path';
import eventBus from '../engine/eventBus.js';

/**
 * dataLoader.js
 *
 * Singleton for loading all YAML data at startup.
 * (MODIFIED v12.0: DEBUG MODE - Verbose Logging)
 */

// --- Maps to be populated from YAML ---
export const ACTIVITIES_MAP = {};
export const DISCOVERABLE_ACTIVITIES = {};
export const ACTIVITY_COSTS = {};
export const DYNAMIC_AFFORDANCE_MODIFIERS = {};
export const ITEM_CATALOG = {};
export const CROWD_SCHEDULES = {};
export const RANDOM_EVENTS = {};
export const DIALOGUE_LIBRARY = {};
export const CULTURE_DATA = {};
// --- END ---


class DataLoader {
  constructor() {
    this.demographics = null;
    this.worldData = null; 
    this.activities = null;
    this.locationGraph = null;
    this.weatherPatterns = null;
  }

  log(message, level = 'low') {
    const event = level === 'error' ? 'log:error' : 'log:info';
    eventBus.queue(event, level, message);
    
    // In debug mode, also print directly to console to ensure visibility before crash
    if (level === 'error' || level === 'warn') {
        console.log(message);
    }
  }

  logCritical(message) {
    console.error(message);
    eventBus.emitNow('log:error', message);
  }

  /**
   * @description Loads and parses a YAML file asynchronously with robust error handling.
   * @param {string} filename - The name of the YAML file.
   * @returns {Promise<object | null>} The parsed YAML content.
   */
  async loadYaml(filename) {
    const rawPath = path.join(process.cwd(), 'data', filename);
    
    try {
      // 1. Check Existence
      try {
        await fsPromises.access(rawPath);
      } catch {
        this.logCritical(`[DataLoader] ❌ FILE NOT FOUND: Expected at ${rawPath}`);
        return null;
      }

      // 2. Read File
      const fileContents = await fsPromises.readFile(rawPath, 'utf8');
      
      // 3. Check Empty
      if (!fileContents || fileContents.trim().length === 0) {
          this.logCritical(`[DataLoader] ⚠️ FILE EMPTY: ${filename} exists but has 0 bytes or only whitespace.`);
          return null;
      }

      // 4. Parse YAML
      const parsed = yaml.load(fileContents);
      
      if (!parsed) {
          this.logCritical(`[DataLoader] ⚠️ PARSE NULL: ${filename} was parsed but resulted in null/undefined.`);
          return null;
      }

      this.log(`[DataLoader] ✅ Loaded: ${filename}`);
      return parsed;

    } catch (e) {
      this.logCritical(`[DataLoader] ❌ CRITICAL ERROR loading ${filename}`);
      
      if (e.name === 'YAMLException') {
          this.logCritical(`[DataLoader] YAML SYNTAX ERROR in ${filename}:`);
          this.logCritical(e.message); // Print specific line number and reason
      } else {
          this.logCritical(`[DataLoader] System Error: ${e.message}`);
      }
      return null; 
    }
  }
  
  processActivities(activitiesData) {
    if (!activitiesData || !activitiesData.activities) {
      this.log('[DataLoader] ❌ activities.yaml is malformed. Missing root "activities" key.', 'error');
      // Do not throw here, allow partial load, but log heavily
      return;
    }

    try {
        for (const activity of activitiesData.activities) {
        ACTIVITIES_MAP[activity.name] = activity;

        if (activity.location_types) {
            for (const locType of activity.location_types) {
            if (!DISCOVERABLE_ACTIVITIES[locType]) {
                DISCOVERABLE_ACTIVITIES[locType] = [];
            }
            DISCOVERABLE_ACTIVITIES[locType].push(activity.name);
            
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
        this.log(`[DataLoader] Processed ${totalActivities} activities.`);
    } catch (e) {
        this.logCritical(`[DataLoader] Error processing activities: ${e.message}`);
    }
  }

  _processWorldData(worldData, eventsData) {
    // 1. Process Typical Prices (from economics.yaml)
    const typicalPrices = worldData?.typical_prices || [];
    if (typicalPrices.length === 0) {
        this.log('[DataLoader] ⚠️ economics.yaml appears empty or missing "typical_prices".', 'warn');
    }

    const priceMap = typicalPrices.reduce((acc, item) => {
        if (Array.isArray(item.price)) {
            acc[item.item] = (item.price[0] + item.price[1]) / 2;
        } else {
            acc[item.item] = item.price;
        }
        return acc;
    }, {});

    // Populate ACTIVITY_COSTS
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
    
    // 2. Process Dynamic Affordance Modifiers (from events.yaml)
    if (eventsData?.dynamic_affordance_modifiers) {
        Object.assign(DYNAMIC_AFFORDANCE_MODIFIERS, {
            modifiers: [...eventsData.dynamic_affordance_modifiers]
        });
        this.log(`[DataLoader] Loaded ${DYNAMIC_AFFORDANCE_MODIFIERS.modifiers.length} dynamic modifiers.`);
    } else {
        this.log('[DataLoader] ⚠️ dynamic_affordance_modifiers missing in events.yaml.', 'warn');
        Object.assign(DYNAMIC_AFFORDANCE_MODIFIERS, { modifiers: [] });
    }

    // 3. Process Random Events (from events.yaml)
    if (eventsData) {
        if (eventsData.random_street_events) RANDOM_EVENTS['street'] = eventsData.random_street_events;
        if (eventsData.random_subway_events) RANDOM_EVENTS['subway'] = eventsData.random_subway_events;
        if (eventsData.random_bar_events) RANDOM_EVENTS['bar'] = eventsData.random_bar_events;
    }

    // 4. Populate ITEM_CATALOG
    const rawItems = [
        { id: 'canned_soup', name: 'Canned Soup', type: 'food', cost: 3.00, energy_boost: 10, hunger_reduction: 30, uses: 1, tags: ['kitchen'] },
        { id: 'tv_dinner', name: 'TV Dinner', type: 'food', cost: 5.00, energy_boost: 5, hunger_reduction: 40, uses: 1, tags: ['microwave', 'tv'] },
        { id: 'protein_bar', name: 'Protein Bar', type: 'food', cost: 2.50, energy_boost: 15, hunger_reduction: 15, uses: 1, tags: ['snack'] },
        { id: 'programming_book', name: 'Y2K Programming Book', type: 'tool', cost: 45.00, skill_mod: 'programming', skill_boost: 0.5, uses: Infinity, tags: ['intellectual'] },
        { id: 'art_supplies', name: 'Sketchpad & Pencils', type: 'tool', cost: 15.00, skill_mod: 'art', skill_boost: 0.3, uses: Infinity, tags: ['creative'] },
        { id: 'workout_tapes', name: 'Workout VHS Tapes', type: 'tool', cost: 20.00, skill_mod: 'sports', skill_boost: 0.4, uses: Infinity, tags: ['active'] },
        { id: 'nice_watch', name: 'Nice Watch', type: 'apparel', cost: 150.00, social_mod: 0.2, uses: Infinity, tags: ['fashion', 'status'] },
        { id: 'cheap_jewelry', name: 'Cheap Necklace', type: 'gift', cost: 10.00, social_mod: 0.05, uses: 1, tags: ['gift', 'low_value'] },
        { id: 'bouquet', name: 'Bouquet of Flowers', type: 'gift', cost: 30.00, social_mod: 0.15, uses: 1, tags: ['gift', 'date'] },
        { id: 'energy_drink', name: 'Energy Drink', type: 'consumable', cost: 3.50, energy_boost: 30, uses: 1, tags: ['caffeine'] },
    ];
    
    rawItems.forEach(item => {
        ITEM_CATALOG[item.id] = item;
    });
  }

  async loadAllData() {
    this.log('[DataLoader] Starting asynchronous data load...');
    
    const fileList = [
        'demographics.yaml',
        'locations.yaml',
        'economics.yaml',
        'culture.yaml',
        'events.yaml',
        'location_graph.yaml',
        'activities.yaml', 
        'crowd_schedules.yaml',
        'weather_patterns.yaml',
        'dialogue.yaml'
    ];

    // Load sequentially just to get clean logs (parallel is faster, but this debugs better)
    // Actually, stick to parallel for speed, but catch individual errors in loadYaml
    const results = await Promise.all(fileList.map(f => this.loadYaml(f)));

    // Map results back to variables for clarity
    const [
      demographicsData,
      locationsData,
      economicsData,
      cultureData,
      eventsData,
      locationGraphData,
      activitiesData,
      crowdData,
      weatherData,
      dialogueData
    ] = results;

    // --- CRITICAL CHECK ---
    const missingFiles = [];
    results.forEach((res, index) => {
        if (!res) missingFiles.push(fileList[index]);
    });

    if (missingFiles.length > 0) {
      const msg = `\n\n[DataLoader] 🛑 FATAL ERROR: The following files failed to load:\n${missingFiles.map(f => ` - ${f}`).join('\n')}\nCheck console logs above for specific syntax errors or paths.\n`;
      this.logCritical(msg);
      throw new Error(msg); // This throws back to Matrix.js
    }
    
    // Assign properties
    this.demographics = demographicsData;
    this.activities = activitiesData;
    this.locationGraph = locationGraphData;
    this.weatherPatterns = weatherData;

    // Aggregate world data
    this.worldData = {
        ...locationsData,
        ...economicsData
    };
    
    this.log('[DataLoader] Processing activities...');
    this.processActivities(this.activities);

    this.log('[DataLoader] Processing world data...');
    this._processWorldData(this.worldData, eventsData);

    if (cultureData) {
        Object.assign(CULTURE_DATA, cultureData);
    }

    if (dialogueData?.PHRASE_LIBRARY) {
        Object.assign(DIALOGUE_LIBRARY, dialogueData.PHRASE_LIBRARY);
    }

    if (crowdData?.schedules) {
        Object.assign(CROWD_SCHEDULES, crowdData.schedules);
    }
    
    this.log('[DataLoader] ✅ All YAML data loaded successfully.', 'medium');
  }
}

export const dataLoader = new DataLoader();