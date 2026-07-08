import crypto from 'crypto';
import { GAME_BALANCE } from '../data/balance.js';
import worldGraph from '../data/worldGraph.js';
const LIFECYCLE = GAME_BALANCE.LIFECYCLE;

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

    const workDays = agent.job?.workDays ?? [1, 2, 3, 4, 5];
    const dayOfWeek = worldGraph.currentDay ?? 0;
    if (Array.isArray(workDays) && workDays.length > 0 && !workDays.includes(dayOfWeek)) {
        return false;
    }
    
    hour = Math.max(0, Math.min(23, Math.floor(hour)));
    const start = agent.workStartHour ?? UTILITIES_CONFIG.DEFAULT_WORK_START;
    const end = agent.workEndHour ?? UTILITIES_CONFIG.DEFAULT_WORK_END;

    // Overtime Logic
    const isWorkaholic = (agent.persona?.conscientiousness ?? 0.5) > 0.8;
    const actualEnd = isWorkaholic ? end + 1 : end;

    if (start < actualEnd) return hour >= start && hour < actualEnd;
    return hour >= start || hour < actualEnd;
}

export function getWorkingTagForJobTitle(title = '') {
    const lower = String(title || '').toLowerCase();
    if (lower.includes('officer') || lower.includes('police') || lower.includes('detective') || lower.includes('sheriff')) {
        return 'fsm_working_police';
    }
    if (lower.includes('teacher') || lower.includes('professor') || lower.includes('tutor') || lower.includes('instructor')) {
        return 'fsm_working_teacher';
    }
    if (lower.includes('doctor') || lower.includes('nurse') || lower.includes('physician') || lower.includes('surgeon') || lower.includes('medic') || lower.includes('paramedic') || lower.includes('therapist') || lower.includes('pharmacist')) {
        return 'fsm_working_medical';
    }
    if (lower.includes('lawyer') || lower.includes('attorney') || lower.includes('paralegal') || lower.includes('judge') || lower.includes('counsel')) {
        return 'fsm_working_legal';
    }
    if (
        lower.includes('graphic designer') ||
        lower.includes('web designer') ||
        lower.includes('ui designer') ||
        lower.includes('ux designer') ||
        lower.includes('product designer') ||
        lower.includes('industrial designer') ||
        lower.includes('developer') ||
        lower.includes('programmer') ||
        lower.includes('engineer') ||
        lower.includes('coder') ||
        lower.includes('analyst') ||
        lower.includes('sysadmin') ||
        lower.includes('tech')
    ) {
        return 'fsm_working_tech';
    }
    if (
        lower.includes('artist') ||
        lower.includes('musician') ||
        lower.includes('actor') ||
        lower.includes('writer') ||
        lower.includes('photographer') ||
        lower.includes('director') ||
        lower.includes('creative') ||
        lower.includes('fashion designer') ||
        lower.includes('interior designer') ||
        lower.includes('set designer') ||
        lower.includes('costume designer') ||
        lower.includes('lighting designer') ||
        lower.includes('sound designer')
    ) {
        return 'fsm_working_arts';
    }
    if (lower.includes('chef') || lower.includes('cook') || lower.includes('baker') || lower.includes('sous chef') || lower.includes('line cook')) {
        return 'fsm_working_kitchen';
    }
    if (lower.includes('bartender') || lower.includes('waiter') || lower.includes('server') || lower.includes('cashier') || lower.includes('clerk') || lower.includes('retail') || lower.includes('sales') || lower.includes('barista')) {
        return 'fsm_working_service';
    }
    return 'fsm_working_office';
}

function getPreferredWorkLocationTypes(tag) {
    switch (tag) {
        case 'fsm_working_police':
            return ['street', 'office'];
        case 'fsm_working_teacher':
            return ['school', 'library', 'office'];
        case 'fsm_working_medical':
            return ['hospital', 'clinic', 'office'];
        case 'fsm_working_legal':
            return ['office'];
        case 'fsm_working_tech':
            return ['office', 'internet_cafe'];
        case 'fsm_working_arts':
            return ['studio', 'venue', 'office', 'bar'];
        case 'fsm_working_kitchen':
            return ['restaurant', 'bar'];
        case 'fsm_working_service':
            return ['store', 'restaurant', 'bar', 'coffee_shop', 'office'];
        default:
            return ['office'];
    }
}

function pickBestNodeByTypes(agent, candidateTypes, opts = {}) {
    const graph = opts.graph || worldGraph;
    if (!graph?.nodesByType || !graph?.nodes) return null;
    const origin = agent.locationId || agent.homeLocationId;
    const preferOutOfHome = opts.preferOutOfHome !== false;
    const currentTick = Number.isFinite(opts.currentTick) ? opts.currentTick : 0;
    const recentDestinations = Array.isArray(agent.stateContext?.recentDestinations)
        ? agent.stateContext.recentDestinations
        : [];
    const recentVisitCounts = new Map();
    for (const visit of recentDestinations) {
        if (!visit?.locationId) continue;
        if (Number.isFinite(visit.tick) && currentTick - visit.tick > 192) continue;
        recentVisitCounts.set(visit.locationId, (recentVisitCounts.get(visit.locationId) || 0) + 1);
    }

    let best = null;
    let bestScore = -Infinity;
    const isWeekend = graph.currentDay === 0 || graph.currentDay === 6;
    const isEvening = graph.currentHour >= 18 || graph.currentHour < 2;
    const openness = agent.persona?.openness ?? 0.5;

    for (const type of candidateTypes) {
        const nodes = graph.nodesByType[type] || [];
        for (const node of nodes) {
            if (!node?.key) continue;
            if (graph.isLocationOpen && !graph.isLocationOpen(node)) continue;

            const travel = graph.getTravelCost ? graph.getTravelCost(origin, node.key) : 0;
            if (!Number.isFinite(travel)) continue;

            const affordances = graph.getLocationAffordances ? graph.getLocationAffordances(node) : [];
            const topQuality = affordances.length > 0 ? Math.max(...affordances.map(a => a.quality || 0)) : 0.1;
            const homePenalty = preferOutOfHome && node.key === agent.homeLocationId ? 3 : 0;
            const visitPenalty = (recentVisitCounts.get(node.key) || 0) * 2.5;
            const noveltyBonus = (recentVisitCounts.has(node.key) ? 0 : ((Math.random() * 2.0) * openness));

            let temporalBonus = 0;
            if (isEvening && ['bar', 'movie_theater', 'venue'].includes(type)) temporalBonus += 1.5;
            if (isWeekend && ['park', 'mall', 'movie_theater', 'grocery_store'].includes(type)) temporalBonus += 1.0;

            let intentBonus = 0;
            if (opts.intent === 'groceries' && ['grocery_store', 'store', 'mall'].includes(type)) intentBonus += 2.5;
            if (opts.intent === 'movie_night' && ['movie_theater', 'video_store', 'bar'].includes(type)) intentBonus += 2.0;
            if (opts.intent === 'nightlife' && ['bar', 'venue', 'restaurant'].includes(type)) intentBonus += 1.8;

            const score = (topQuality * 10) - (travel * 2) - homePenalty - visitPenalty + noveltyBonus + temporalBonus + intentBonus;

            if (score > bestScore) {
                bestScore = score;
                best = node;
            }
        }
    }
    return best;
}

function getPreferredTypesForGoal(agent, goalState) {
    if (!goalState) return [];
    if (goalState.startsWith('fsm_working')) {
        const tag = (goalState === 'fsm_working')
            ? (agent.stateContext?.workingTag || getWorkingTagForJobTitle(agent.job?.title || ''))
            : goalState;
        return getPreferredWorkLocationTypes(tag);
    }
    if (goalState === 'fsm_shopping') return ['grocery_store', 'mall', 'store', 'comic_shop', 'record_store', 'bookstore'];
    if (goalState === 'fsm_socializing') return ['bar', 'restaurant', 'park', 'coffee_shop', 'venue', 'movie_theater', 'mall'];
    if (goalState === 'fsm_recreation') return ['park', 'movie_theater', 'venue', 'library', 'bar', 'arcade', 'bookstore'];
    if (goalState === 'fsm_eating') return ['restaurant', 'coffee_shop', 'bar', 'home'];
    return [];
}

export function assignWorkLocationByJob(agent, graph = worldGraph) {
    if (!agent || !graph?.nodesByType) return null;
    const tag = getWorkingTagForJobTitle(agent.job?.title || '');
    const preferredTypes = getPreferredWorkLocationTypes(tag);
    const best = pickBestNodeByTypes(agent, preferredTypes, { graph, preferOutOfHome: true });
    return best?.key || null;
}

export function resolveDestinationForGoal(agent, goalState, opts = {}) {
    if (!agent || !goalState) return null;
    const graph = opts.graph || worldGraph;
    const preferOutOfHome = opts.preferOutOfHome !== false;

    if (goalState.startsWith('fsm_working')) {
        const currentWork = graph?.nodes?.[agent.workLocationId];
        if (currentWork) return agent.workLocationId;
        const newWork = assignWorkLocationByJob(agent, graph);
        if (newWork) agent.workLocationId = newWork;
        return newWork || null;
    }

    const preferredTypes = getPreferredTypesForGoal(agent, goalState);
    if (preferredTypes.length === 0) return null;
    let candidateTypes = preferredTypes;
    if (goalState === 'fsm_shopping' && opts.shoppingPurpose === 'groceries') {
        candidateTypes = ['grocery_store', 'store', 'mall'];
    } else if (goalState === 'fsm_recreation' && opts.outingIntent === 'movie_night') {
        candidateTypes = ['movie_theater', 'video_store', 'park', 'bar', 'library'];
    } else if (goalState === 'fsm_socializing' && opts.outingIntent === 'nightlife') {
        candidateTypes = ['bar', 'venue', 'restaurant', 'coffee_shop'];
    }
    const best = pickBestNodeByTypes(agent, candidateTypes, {
        graph,
        preferOutOfHome,
        currentTick: opts.currentTick,
        intent: opts.shoppingPurpose || opts.outingIntent || null
    });
    return best?.key || null;
}

export function transitionWithCommuteIfNeeded(agent, goalState, opts = {}) {
    const destination = opts.destination
        ? opts.destination
        : resolveDestinationForGoal(agent, goalState, opts);
    if (!destination || destination === agent.locationId) {
        return { isDirty: true, nextState: goalState };
    }

    agent.targetLocationId = destination;
    const currentTick = Number.isFinite(opts.currentTick) ? opts.currentTick : (agent.tickCount ?? 0);
    if (!agent.stateContext) agent.stateContext = {};
    if (!Array.isArray(agent.stateContext.recentDestinations)) {
        agent.stateContext.recentDestinations = [];
    }
    agent.stateContext.recentDestinations.push({ locationId: destination, tick: currentTick });
    if (agent.stateContext.recentDestinations.length > 12) {
        agent.stateContext.recentDestinations.shift();
    }
    agent.intentionStack = [{
        goal: goalState,
        reason: opts.reason || 'goal_transition',
        outingIntent: opts.outingIntent || null,
        shoppingPurpose: opts.shoppingPurpose || null,
        initiatedAtTick: currentTick
    }];
    return { isDirty: true, nextState: 'fsm_commuting' };
}

export function isAgentLateNight(hour) {
    return hour >= UTILITIES_CONFIG.LATE_NIGHT_START || hour < UTILITIES_CONFIG.LATE_NIGHT_END;
}

export function isVenueClosingSoon(hour) {
    return hour >= UTILITIES_CONFIG.VENUE_CLOSE_START && hour < UTILITIES_CONFIG.VENUE_CLOSE_END;
}

// --- Initialization & Generation Helpers ---
export function generateSex() {
  return Math.random() < 0.5 ? 'male' : 'female';
}

export function generateRandomName(demographics, sex = null) {
  const lastNames = demographics?.last_names || ['Doe'];
  const last = lastNames[Math.floor(Math.random() * lastNames.length)];

  let namePool;
  if (sex === 'male') {
    namePool = demographics?.male_first_names || demographics?.first_names || ['John'];
  } else if (sex === 'female') {
    namePool = demographics?.female_first_names || demographics?.first_names || ['Jane'];
  } else {
    const allNames = [
      ...(demographics?.male_first_names || []),
      ...(demographics?.female_first_names || []),
      ...(demographics?.neutral_first_names || []),
    ];
    namePool = allNames.length > 0 ? allNames : (demographics?.first_names || ['Alex']);
  }

  const first = namePool[Math.floor(Math.random() * namePool.length)];
  return `${first} ${last}`;
}

export function generateNameWithFamily(demographics, sex, familyLastName) {
  let namePool;
  if (sex === 'male') {
    namePool = demographics?.male_first_names || ['John'];
  } else if (sex === 'female') {
    namePool = demographics?.female_first_names || ['Jane'];
  } else {
    namePool = demographics?.neutral_first_names || ['Alex'];
  }
  const first = namePool[Math.floor(Math.random() * namePool.length)];
  return `${first} ${familyLastName}`;
}

export function generateRandomAge(worldTime) {
  const dist = LIFECYCLE.AGE_DISTRIBUTION;
  const totalWeight = dist.reduce((sum, d) => sum + d.weight, 0);
  let rand = Math.random() * totalWeight;
  for (const bracket of dist) {
    rand -= bracket.weight;
    if (rand <= 0) {
      return bracket.min + Math.floor(Math.random() * (bracket.max - bracket.min + 1));
    }
  }
  return 25;
}

export function computeBirthDate(age, worldTime) {
  const birth = new Date(worldTime);
  birth.setFullYear(birth.getFullYear() - age);
  birth.setMonth(Math.floor(Math.random() * 12));
  birth.setDate(1 + Math.floor(Math.random() * 28));
  return birth;
}

export function computeAge(birthDate, worldTime) {
  if (!birthDate || !worldTime) return 30;
  const birth = birthDate instanceof Date ? birthDate : new Date(birthDate);
  const now = worldTime instanceof Date ? worldTime : new Date(worldTime);
  let age = now.getFullYear() - birth.getFullYear();
  const monthDiff = now.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) {
    age--;
  }
  return Math.max(0, age);
}

export function computeLifeStage(age) {
  if (age <= LIFECYCLE.LIFE_STAGES.CHILD_MAX) return 'child';
  if (age <= LIFECYCLE.LIFE_STAGES.TEEN_MAX) return 'teen';
  if (age <= LIFECYCLE.LIFE_STAGES.ADULT_MAX) return 'adult';
  return 'elder';
}

export function getLastName(fullName) {
  if (!fullName) return 'Doe';
  const parts = fullName.split(' ');
  return parts.length > 1 ? parts[parts.length - 1] : fullName;
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

// --- Political Profile Generation ---
const POL = GAME_BALANCE.POLITICS;

const PERSONA_PARTY_LEANINGS = {
  'The Hustler':       { democrat: 0.35, republican: 0.40, liberal: 0.02, working_families: 0.03, independent: 0.20 },
  'The Hermit':        { democrat: 0.30, republican: 0.25, liberal: 0.05, working_families: 0.05, independent: 0.35 },
  'The Party Animal':  { democrat: 0.50, republican: 0.10, liberal: 0.15, working_families: 0.10, independent: 0.15 },
  'The Anxious Artist':{ democrat: 0.50, republican: 0.05, liberal: 0.20, working_families: 0.15, independent: 0.10 },
  'The Zen Master':    { democrat: 0.40, republican: 0.15, liberal: 0.10, working_families: 0.10, independent: 0.25 },
};

const BOROUGH_OPINION_BIAS = {
  manhattan:      { crime_policing: -10, development: 10, rent_housing: -20, transit: 20, quality_of_life: -10 },
  brooklyn:       { crime_policing: -15, development: -10, rent_housing: -30, transit: 25, quality_of_life: -15 },
  queens:         { crime_policing: 0, development: 5, rent_housing: -15, transit: 30, quality_of_life: 0 },
  bronx:          { crime_policing: -20, development: -15, rent_housing: -40, transit: 35, quality_of_life: -20 },
  staten_island:  { crime_policing: 25, development: 20, rent_housing: 15, transit: -15, quality_of_life: 25 },
};

const JOB_OPINION_MODIFIERS = {
  'Investment Banker':     { crime_policing: 10, development: 30, rent_housing: 25, transit: -10, quality_of_life: 15 },
  'Management Consultant': { crime_policing: 5, development: 25, rent_housing: 15, transit: -5, quality_of_life: 10 },
  'Lawyer (Corporate)':    { crime_policing: 15, development: 20, rent_housing: 20, transit: 0, quality_of_life: 10 },
  'Teacher':               { crime_policing: -20, development: -10, rent_housing: -25, transit: 20, quality_of_life: -15 },
  'Social Worker':         { crime_policing: -30, development: -20, rent_housing: -35, transit: 25, quality_of_life: -25 },
  'Police Officer':        { crime_policing: 40, development: 5, rent_housing: 5, transit: 0, quality_of_life: 35 },
  'Firefighter':           { crime_policing: 20, development: 0, rent_housing: -5, transit: 10, quality_of_life: 15 },
  'Nurse':                 { crime_policing: -10, development: -5, rent_housing: -15, transit: 15, quality_of_life: -5 },
  'Bartender':             { crime_policing: -5, development: -15, rent_housing: -20, transit: 10, quality_of_life: -20 },
  'Artist (Freelance)':    { crime_policing: -25, development: -30, rent_housing: -35, transit: 15, quality_of_life: -30 },
  'Musician (Gigging)':    { crime_policing: -20, development: -25, rent_housing: -30, transit: 10, quality_of_life: -25 },
  'Actor (Auditioning)':   { crime_policing: -15, development: -20, rent_housing: -25, transit: 10, quality_of_life: -20 },
  'Journalist/Writer':     { crime_policing: -15, development: -10, rent_housing: -20, transit: 15, quality_of_life: -15 },
  'Retail Associate':      { crime_policing: 0, development: -5, rent_housing: -15, transit: 10, quality_of_life: 0 },
  'Software Developer (Web)': { crime_policing: -5, development: 15, rent_housing: 0, transit: 5, quality_of_life: -5 },
};

function _pickPartyWeighted(weights) {
  const parties = Object.keys(weights);
  const totalWeight = parties.reduce((sum, p) => sum + weights[p], 0);
  let rand = Math.random() * totalWeight;
  for (const party of parties) {
    rand -= weights[party];
    if (rand <= 0) return party;
  }
  return 'democrat';
}

export function generatePoliticalProfile(agent) {
  if (!agent || agent.lifeStage === 'child') {
    return { party: null, opinions: null, engagement: 0 };
  }

  const persona = agent.persona || {};
  const personaName = _matchPersonaArchetype(persona);
  const borough = _getAgentBorough(agent);
  const jobTitle = agent.job?.title || '';
  const salary = agent.job?.salary || 0;

  // 1. Party assignment -- blend persona + borough + income
  let partyWeights = { ...(PERSONA_PARTY_LEANINGS[personaName] || PERSONA_PARTY_LEANINGS['The Zen Master']) };

  if (borough === 'staten_island') {
    partyWeights.republican = (partyWeights.republican || 0.2) + 0.15;
    partyWeights.democrat = Math.max(0, (partyWeights.democrat || 0.5) - 0.10);
  } else if (borough === 'bronx' || borough === 'brooklyn') {
    partyWeights.democrat = (partyWeights.democrat || 0.5) + 0.10;
    partyWeights.working_families = (partyWeights.working_families || 0.05) + 0.05;
  }

  if (salary > 80000) {
    partyWeights.republican = (partyWeights.republican || 0.2) + 0.10;
  } else if (salary < 30000 && salary > 0) {
    partyWeights.democrat = (partyWeights.democrat || 0.5) + 0.05;
    partyWeights.working_families = (partyWeights.working_families || 0.05) + 0.05;
  }

  const party = _pickPartyWeighted(partyWeights);

  // 2. Opinions -- start from random baseline, layer borough + job + income + personality
  const opinions = {
    crime_policing: (Math.random() * 40) - 20,
    development: (Math.random() * 40) - 20,
    rent_housing: (Math.random() * 40) - 20,
    transit: (Math.random() * 40) - 20,
    quality_of_life: (Math.random() * 40) - 20,
  };

  const boroughBias = BOROUGH_OPINION_BIAS[borough];
  if (boroughBias) {
    for (const issue in boroughBias) {
      opinions[issue] += boroughBias[issue];
    }
  }

  const jobMod = JOB_OPINION_MODIFIERS[jobTitle];
  if (jobMod) {
    for (const issue in jobMod) {
      opinions[issue] += jobMod[issue];
    }
  }

  if (salary > 80000) {
    opinions.development += 15;
    opinions.rent_housing += 15;
    opinions.crime_policing += 10;
  } else if (salary < 30000 && salary > 0) {
    opinions.rent_housing -= 20;
    opinions.transit += 10;
  }

  const extroversion = persona.extroversion ?? 0.5;
  const openness = persona.openness ?? 0.5;
  opinions.quality_of_life += (0.5 - openness) * 30;
  opinions.crime_policing += (0.5 - extroversion) * 10;

  for (const issue in opinions) {
    opinions[issue] = Math.max(-100, Math.min(100, Math.round(opinions[issue])));
  }

  // 3. Engagement
  let engagement = POL.ENGAGEMENT_BASE;
  if (agent.interests && agent.interests.includes('politics')) {
    engagement += POL.ENGAGEMENT_POLITICS_INTEREST_BONUS;
  }
  if (agent.lifeStage === 'elder') engagement += POL.ENGAGEMENT_AGE_ELDER_BONUS;
  if (agent.lifeStage === 'teen') engagement = Math.max(5, engagement - 25);

  const educationReq = agent.job?.education_req || '';
  if (educationReq === 'Graduate') {
    engagement += POL.ENGAGEMENT_EDUCATION_GRADUATE_BONUS;
  } else if (educationReq === 'College') {
    engagement += POL.ENGAGEMENT_EDUCATION_COLLEGE_BONUS;
  }

  engagement += (Math.random() * 20) - 10;
  engagement = Math.max(0, Math.min(100, Math.round(engagement)));

  return { party, opinions, engagement };
}

function _matchPersonaArchetype(persona) {
  const e = persona.extroversion ?? 0.5;
  const c = persona.conscientiousness ?? 0.5;
  const s = persona.stressProneness ?? 0.5;

  let bestMatch = 'The Zen Master';
  let bestDist = Infinity;
  for (const arch of ARCHETYPES) {
    const dist = Math.abs(arch.e - e) + Math.abs(arch.c - c) + Math.abs(arch.s - s);
    if (dist < bestDist) {
      bestDist = dist;
      bestMatch = arch.name;
    }
  }
  return bestMatch;
}

function _getAgentBorough(agent) {
  const locId = agent.homeLocationId || agent.locationId || '';
  if (typeof locId !== 'string') return 'manhattan';
  if (locId.startsWith('manhattan')) return 'manhattan';
  if (locId.startsWith('brooklyn')) return 'brooklyn';
  if (locId.startsWith('queens')) return 'queens';
  if (locId.startsWith('bronx')) return 'bronx';
  if (locId.startsWith('staten_island')) return 'staten_island';
  return 'manhattan';
}