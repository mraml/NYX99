import { dataLoader, ACTIVITIES_MAP, ITEM_CATALOG } from '../../data/dataLoader.js'; 
import { hasHobbyItem } from './agentInventory.js';
// FIX: Change named import to default import to resolve P0 crash
import worldGraph from '../../data/worldGraph.js';

const activityCache = new Map();
const missingActivityWarnings = new Set();

const WORKING_ACTIVITY_FALLBACK_TAGS = ['fsm_working_service', 'fsm_working_office'];

export function clearActivityCache() {
  activityCache.clear();
  missingActivityWarnings.clear();
}

/** Generic fsm_working uses job-specific YAML via stateContext.workingTag. */
function resolveActivityLookupTag(agent, newState) {
  if (newState === 'fsm_working' && agent.stateContext?.workingTag) {
    return agent.stateContext.workingTag;
  }
  return newState;
}

function collectValidActivities(tag, locationType) {
  const primary = getValidActivities(tag, locationType);
  if (primary.length > 0) return primary;
  for (const fb of WORKING_ACTIVITY_FALLBACK_TAGS) {
    if (fb === tag) continue;
    const found = getValidActivities(fb, locationType);
    if (found.length > 0) return found;
  }
  const anyLoc = getValidActivities(tag, 'any');
  if (anyLoc.length > 0) return anyLoc;
  for (const fb of WORKING_ACTIVITY_FALLBACK_TAGS) {
    if (fb === tag) continue;
    const found = getValidActivities(fb, 'any');
    if (found.length > 0) return found;
  }
  return [];
}

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
          agent.currentActivity = 'passing time';
          agent.currentActivityName = 'idle';
      }
      return;
  }

  const locationNode = worldGraph.nodes[agent.locationId];
  const locationType = locationNode?.type;

  const lookupTag = resolveActivityLookupTag(agent, newState);
  const validActivities = collectValidActivities(lookupTag, locationType);

  if (validActivities.length === 0) {
    const label = String(lookupTag).replace(/^fsm_/, '').replace(/_/g, ' ') || 'working';
    agent.currentActivityName = label;
    agent.currentActivity = 'handling job responsibilities';
    const warnKey = `${lookupTag}|${locationType || 'unknown'}`;
    if (!missingActivityWarnings.has(warnKey)) {
      missingActivityWarnings.add(warnKey);
      console.warn(`[Activity] No activity match for tag="${lookupTag}" at location_type="${locationType || 'unknown'}".`);
    }
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
      if (skillTag && (newState === 'fsm_recreation' || lookupTag.startsWith('fsm_working'))) {
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