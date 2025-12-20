import { dataLoader, ACTIVITIES_MAP, ITEM_CATALOG } from '../../data/dataLoader.js'; 
import { hasHobbyItem } from './agentInventory.js';
// FIX: Change named import to default import to resolve P0 crash
import worldGraph from '../../data/worldGraph.js';

const activityCache = new Map();

function setSubLocation(agent, locationType) {
  const rawPlaces = (locationType && dataLoader.worldData.places && dataLoader.worldData.places[locationType]) 
    ? dataLoader.worldData.places[locationType]
    : [];
  const places = Array.isArray(rawPlaces) ? rawPlaces : []; 
  if (places.length > 0) {
      agent.subLocation = places[Math.floor(Math.random() * places.length)];
  } else {
      agent.subLocation = null;
  }
}

export function rehydrateActivity(agent) {
  const savedActivity = ACTIVITIES_MAP[agent.currentActivityName];
  const locationNode = worldGraph.nodes[agent.locationId];
  setSubLocation(agent, locationNode?.type);
}

function getValidActivities(newState, locationType) {
  // Guard against undefined state
  if (!newState) return [];

  const cacheKey = `${newState}_${locationType}`;
  if (activityCache.has(cacheKey)) return activityCache.get(cacheKey);

  const validActivities = [];
  for (const key in ACTIVITIES_MAP) {
    const activity = ACTIVITIES_MAP[key];
    if (activity.tags && (activity.tags ?? []).includes(newState)) {
      if ((activity.location_types ?? []).includes(locationType) || (activity.location_types ?? []).includes('any')) {
         validActivities.push(activity);
      }
    }
  }
  activityCache.set(cacheKey, validActivities);
  return validActivities;
}

/**
 * REVISED: Removed hardcoded strings like "Anxiously reading a book"
 * The agent's currentActivity string will now be the base action string
 * defined in the YAML, which is more predictable and configurable.
 */
function getColorizedActivityText(baseAction, agent) {
    // Only return the base action string from the YAML/dataLoader
    return baseAction; 
}

export function updateCurrentActivity(agent, newState, hour = 12) {
  // --- CRITICAL FIX: Guard against undefined newState ---
  if (!newState) {
      if (!agent.currentActivity) {
          agent.currentActivity = '[Idle]';
          agent.currentActivityName = 'idle';
      }
      return;
  }

  const locationNode = worldGraph.nodes[agent.locationId];
  const locationType = locationNode?.type;
  
  const validActivities = getValidActivities(newState, locationType);

  if (validActivities.length === 0) {
    const stateName = String(newState).replace('fsm_', '');
    agent.currentActivityName = stateName;
    agent.currentActivity = `[${stateName}]`; // Fallback to raw FSM state name
    setSubLocation(agent, locationType);
    return;
  }

  const chosenActivity = validActivities[Math.floor(Math.random() * validActivities.length)];
  const activityActions = Array.isArray(chosenActivity?.actions) ? chosenActivity.actions : [];
  
  if (activityActions.length > 0) {
    // The base action text must come from the YAML/dataLoader
    const baseAction = activityActions[Math.floor(Math.random() * activityActions.length)];
    agent.currentActivity = getColorizedActivityText(baseAction, agent);
    agent.currentActivityName = chosenActivity.name;

    if (chosenActivity.interest_tags) {
      const skillTag = (chosenActivity.interest_tags ?? []).find(tag => (agent.skills ?? {}).hasOwnProperty(tag));
      if (skillTag && (newState === 'fsm_recreation' || newState.startsWith('fsm_working_'))) {
          const hobbyItem = hasHobbyItem(agent, skillTag);
          const boost = hobbyItem ? 0.2 : 0.1;
          agent.skills[skillTag] = Math.min(100, (agent.skills[skillTag] ?? 0) + boost);
      }
    }
  } else {
    // Fallback if the activity object is found but has no actions array
    agent.currentActivity = chosenActivity.name || newState;
    agent.currentActivityName = chosenActivity.name || newState.replace('fsm_', '');
  }
  
  setSubLocation(agent, locationType);
}