import crypto from 'crypto';
import { GAME_BALANCE } from '../data/balance.js'; 

const UTILITIES_CONFIG = {
    // Work Defaults
    DEFAULT_WORK_START: 9,
    DEFAULT_WORK_END: 17,
    LATE_NIGHT_START: 23,
    LATE_NIGHT_END: 6,
    VENUE_CLOSE_START: 1,
    VENUE_CLOSE_END: 5,
    
    // Relationship Seeding
    RELATIONSHIP: {
        ROOMMATE_MIN: 30,
        ROOMMATE_MAX: 70,
        COWORKER_MIN: 30,
        COWORKER_MAX: 60,
        STRANGER_MIN: -10,
        STRANGER_MAX: 30,
        TARGET_COUNT: 5
    },
    
    // Aspiration Targets
    ASPIRATION: {
        RICH_TARGET_HIGH: 100000,
        RICH_TARGET_LOW: 50000,
        POPULAR_TARGET: 10,
        SKILL_TARGET: 100
    }
};

// --- Data Persistence Helpers ---
export function coerceObject(value, defaultValue) {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (e) { return defaultValue; }
  }
  return value ?? defaultValue; 
}

// --- Time & Context Helpers ---
export function isAgentWorkShift(agent, hour) {
    if (!agent || hour === undefined || hour === null) return false;
    if (!agent.workLocationId) return false;
    
    hour = Math.max(0, Math.min(23, Math.floor(hour)));
    const start = agent.workStartHour ?? UTILITIES_CONFIG.DEFAULT_WORK_START;
    const end = agent.workEndHour ?? UTILITIES_CONFIG.DEFAULT_WORK_END;

    // Overtime Logic
    const isWorkaholic = (agent.persona?.conscientiousness ?? 0.5) > 0.8;
    const actualEnd = isWorkaholic ? end + 1 : end;

    if (start < actualEnd) return hour >= start && hour < actualEnd;
    return hour >= start || hour < actualEnd;
}

export function isAgentLateNight(hour) {
    return hour >= UTILITIES_CONFIG.LATE_NIGHT_START || hour < UTILITIES_CONFIG.LATE_NIGHT_END;
}

export function isVenueClosingSoon(hour) {
    return hour >= UTILITIES_CONFIG.VENUE_CLOSE_START && hour < UTILITIES_CONFIG.VENUE_CLOSE_END;
}

// --- Initialization & Generation Helpers ---
export function generateRandomName(demographics) {
  const firstNames = demographics?.first_names || ['John'];
  const lastNames = demographics?.last_names || ['Doe'];
  const first = firstNames[Math.floor(Math.random() * firstNames.length)];
  const last = lastNames[Math.floor(Math.random() * lastNames.length)];
  return `${first} ${last}`;
}

export function generateRandomJob(demographics) {
  const jobs = demographics?.jobs || [{ title: 'Unemployed', salary: 0, hours: [9, 17] }];
  return jobs[Math.floor(Math.random() * jobs.length)];
}

export function generateInterests(demographics) {
  const interestsList = demographics?.interests;
  if (!interestsList || interestsList.length === 0) return ['reading', 'movies'];
  const interests = new Set();
  const numInterests = Math.floor(Math.random() * 3) + 2;
  while (interests.size < numInterests && interests.size < (interestsList ?? []).length) {
    const interest = interestsList[Math.floor(Math.random() * interestsList.length)];
    interests.add(interest);
  }
  return Array.from(interests);
}

// --- Personality Archetypes ---
const ARCHETYPES = [
    { name: 'The Hustler', e: 0.7, c: 0.9, s: 0.7 }, 
    { name: 'The Hermit', e: 0.2, c: 0.6, s: 0.4 },  
    { name: 'The Party Animal', e: 0.9, c: 0.2, s: 0.3 }, 
    { name: 'The Anxious Artist', e: 0.4, c: 0.5, s: 0.9 }, 
    { name: 'The Zen Master', e: 0.5, c: 0.5, s: 0.1 }  
];

export function generatePersona() {
  const base = ARCHETYPES[Math.floor(Math.random() * ARCHETYPES.length)];
  const fuzz = () => (Math.random() * 0.2) - 0.1;
  
  return {
    extroversion: Math.max(0, Math.min(1, base.e + fuzz())),
    conscientiousness: Math.max(0, Math.min(1, base.c + fuzz())),
    stressProneness: Math.max(0, Math.min(1, base.s + fuzz())),
    openness: Math.random() 
  };
}

// --- Smart Relationship Seeding ---
export function seedInitialRelationships(agent, allAgentIds) {
    if (!agent.matrix || !agent.matrix.cacheManager) return {}; 
    
    let relationships = coerceObject(agent.relationships, {});
    
    // If we don't have IDs passed in, fetch from cache
    if (!allAgentIds || allAgentIds.length < 2) {
        if (agent.matrix.cacheManager) {
             allAgentIds = agent.matrix.cacheManager.getAllAgentIds();
        } else {
             return relationships; 
        }
    }

    const addRel = (id, type, minAffinity, maxAffinity) => {
        if (id !== agent.id && !relationships[id]) {
            const affinity = Math.floor(Math.random() * (maxAffinity - minAffinity)) + minAffinity;
            // FIX: Initialize with 'score' matching affinity so sorts work
            relationships[id] = { affinity: affinity, score: affinity, type: type, history: [] };
            return true;
        }
        return false;
    };

    let relationshipsCreated = 0;
    const R = UTILITIES_CONFIG.RELATIONSHIP;
    
    // 1. Roommates (Auto-detect)
    if (agent.homeLocationId) {
        const roommates = allAgentIds.filter(id => {
             if (id === agent.id) return false;
             const other = agent.matrix.cacheManager.getAgent(id);
             return other && other.homeLocationId === agent.homeLocationId;
        });
        
        for (const roommateId of roommates) {
            addRel(roommateId, 'roommate', R.ROOMMATE_MIN, R.ROOMMATE_MAX);
            relationshipsCreated++;
        }
    }

    // 2. Coworkers (Auto-detect)
    if (agent.job && agent.job.title && agent.job.title !== 'Unemployed') {
        let attempts = 0;
        while (relationshipsCreated < 3 && attempts < 50) {
            const randomId = allAgentIds[Math.floor(Math.random() * allAgentIds.length)];
            const otherAgent = agent.matrix.cacheManager.getAgent(randomId);
            
            if (otherAgent && otherAgent.id !== agent.id && otherAgent.job && otherAgent.job.title === agent.job.title) {
                addRel(randomId, 'acquaintance', R.COWORKER_MIN, R.COWORKER_MAX); 
                relationshipsCreated++;
            }
            attempts++;
        }
    }

    // 3. Randoms
    let attempts = 0;
    while (relationshipsCreated < R.TARGET_COUNT && attempts < 50) {
        const randomId = allAgentIds[Math.floor(Math.random() * allAgentIds.length)];
        if (addRel(randomId, 'stranger', R.STRANGER_MIN, R.STRANGER_MAX)) {
            relationshipsCreated++;
        }
        attempts++;
    }
    
    return relationships;
}

export function generateAspiration(agent) {
  const p = agent.persona || {};
  const rand = Math.random();
  const A = UTILITIES_CONFIG.ASPIRATION;
  
  if (p.extroversion > 0.7) {
      if (rand < 0.7) return { type: 'BECOME_POPULAR', target: A.POPULAR_TARGET };
      return { type: 'BECOME_RICH', target: A.RICH_TARGET_LOW };
  }
  
  if (p.conscientiousness > 0.7) {
      if (rand < 0.8) return { type: 'BECOME_RICH', target: A.RICH_TARGET_HIGH };
  }

  if ((p.openness || 0.5) > 0.6) {
      const skills = (agent.interests ?? []).length > 0 ? agent.interests : ['programming', 'art'];
      const skillToMaster = skills[Math.floor(Math.random() * skills.length)];
      return { type: 'MASTER_SKILL', skill: skillToMaster, target: A.SKILL_TARGET };
  }

  if (rand < 0.33) return { type: 'MASTER_SKILL', skill: 'cooking', target: A.SKILL_TARGET };
  if (rand < 0.66) return { type: 'BECOME_RICH', target: A.RICH_TARGET_LOW };
  return { type: 'BECOME_POPULAR', target: A.POPULAR_TARGET }; 
}

export function calculateThresholds(persona) {
  const workModifier = (0.5 - (persona.conscientiousness ?? 0.5)) * GAME_BALANCE.THRESHOLDS.CONSCIENTIOUSNESS_WORK_MOD;
  return {
    eat: GAME_BALANCE.THRESHOLDS.HUNGER_TO_EAT,
    sleep: GAME_BALANCE.THRESHOLDS.ENERGY_TO_SLEEP,
    social: GAME_BALANCE.THRESHOLDS.SOCIAL_TO_SOCIALIZE,
    work: GAME_BALANCE.THRESHOLDS.MONEY_TO_WORK + workModifier,
  };
}