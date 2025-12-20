/**
 * config.js
 *
 * System & Engine Configuration.
 * NOTE: Gameplay balancing numbers (costs, rates, scores) are in data/balance.js
 */

const getEnv = (key, defaultValue) => process.env[key] || defaultValue;

// --- 1. Core Simulation Loop ---
export const TICK_RATE_MS = parseInt(getEnv('TICK_RATE_MS', 3000), 10);
export const UI_RENDER_RATE_MS = parseInt(getEnv('UI_RENDER_RATE_MS', 500), 10);
export const MINUTES_PER_TICK = parseInt(getEnv('MINUTES_PER_TICK', 15), 10);
export const INITIAL_AGENTS = parseInt(getEnv('INITIAL_AGENTS', 1000), 10);

// --- 2. Database & Persistence ---
export const DB_PATH = getEnv('DB_PATH', './nyc_1999.db');
export const MAX_CHECKPOINTS_TO_KEEP = parseInt(getEnv('MAX_CHECKPOINTS_TO_KEEP', '5'), 10);
export const SYNC_INTERVAL_TICKS = 15;
export const CHECKPOINT_INTERVAL_TICKS = 60;

// --- 3. Hard System Limits (Capacities) ---
export const MAX_HUNGER = 100;
export const MAX_ENERGY = 100;
export const MAX_SOCIAL = 100;

export const STARTING_MONEY = 1000;
export const SOCIAL_FAIL_TICK_LIMIT = 8; // Technical limit for loop prevention

// --- 4. Meta-Simulation Settings ---
export const METASIM_AGENT_NAMES = ['Neo', 'Trinity', 'Morpheus', 'Agent Smith'];

// --- 5. Simulation Performance Settings ---
export const LOD2_TICK_INTERVAL = 10; 
export const LOD2_LOCATION_CHANGE_CHANCE = 0.1;

// --- 6. Debugging & Logging ---
// These control the "Legacy" thought bubbles. 
// Note: Deep Sim thoughts (Lizard Brain/Scorer) ignore these and always log on change.
export const ENABLE_DECISION_THOUGHTS = getEnv('ENABLE_DECISION_THOUGHTS', 'true') === 'true';
export const LOG_ALL_ACTION_SCORES = getEnv('LOG_ALL_ACTION_SCORES', 'true') === 'true';
export const LOG_DECISIONS_TO_MEMORY = getEnv('LOG_DECISIONS_TO_MEMORY', 'true') === 'true';
export const DECISION_MEMORY_SCORE_THRESHOLD = parseInt(getEnv('DECISION_MEMORY_SCORE_THRESHOLD', '70'), 10);

export const ENABLE_TRANSITION_THOUGHTS = getEnv('ENABLE_TRANSITION_THOUGHTS', 'true') === 'true';
export const LOG_TRANSITIONS_TO_MEMORY = getEnv('LOG_TRANSITIONS_TO_MEMORY', 'true') === 'true';
export const ENABLE_ACTION_THOUGHTS = getEnv('ENABLE_ACTION_THOUGHTS', 'true') === 'true';
export const ACTION_THOUGHT_CHANCE = parseFloat(getEnv('ACTION_THOUGHT_CHANCE', '0.01'));

export const ENABLE_NEED_THOUGHTS = getEnv('ENABLE_NEED_THOUGHTS', 'true') === 'true';
export const NEED_THOUGHT_CHANCE = parseFloat(getEnv('NEED_THOUGHT_CHANCE', '0.01'));
export const LOG_CRITICAL_NEEDS_TO_MEMORY = getEnv('LOG_CRITICAL_NEEDS_TO_MEMORY', 'true') === 'true';

export const ENABLE_SOCIAL_THOUGHTS = getEnv('ENABLE_SOCIAL_THOUGHTS', 'true') === 'true';
export const LOG_ALL_SOCIALS_TO_MEMORY = getEnv('LOG_ALL_SOCIALS_TO_MEMORY', 'true') === 'true';
export const LOG_RELATIONSHIP_MILESTONES = getEnv('LOG_RELATIONSHIP_MILESTONES', 'true') === 'true';

export const ENABLE_TRAVEL_THOUGHTS = getEnv('ENABLE_TRAVEL_THOUGHTS', 'true') === 'true';
export const LOG_POVERTY_TO_MEMORY = getEnv('LOG_POVERTY_TO_MEMORY', 'true') === 'true';

export const ENABLE_FINANCIAL_THOUGHTS = getEnv('ENABLE_FINANCIAL_THOUGHTS', 'true') === 'true';
export const LOG_TRANSACTIONS_TO_MEMORY = getEnv('LOG_TRANSACTIONS_TO_MEMORY', 'true') === 'true';

export const DISABLE_ALL_THINKING = getEnv('DISABLE_ALL_THINKING', 'false') === 'true';
export const DEBUG_AGENT_IDS = getEnv('DEBUG_AGENT_IDS', '').split(',').filter(id => id.length > 0);

export function shouldLogThinking(agent, thinkingType = 'general') {
  if (DISABLE_ALL_THINKING) return false;
  if (agent.lod !== 1) return false;
  if (DEBUG_AGENT_IDS.length > 0 && !DEBUG_AGENT_IDS.includes(agent.id)) return false;
  
  switch (thinkingType) {
    case 'decision': return ENABLE_DECISION_THOUGHTS;
    case 'transition': return ENABLE_TRANSITION_THOUGHTS;
    case 'action': return ENABLE_ACTION_THOUGHTS;
    case 'need': return ENABLE_NEED_THOUGHTS;
    case 'social': return ENABLE_SOCIAL_THOUGHTS;
    case 'travel': return ENABLE_TRAVEL_THOUGHTS;
    case 'financial': return ENABLE_FINANCIAL_THOUGHTS;
    default: return true;
  }
}