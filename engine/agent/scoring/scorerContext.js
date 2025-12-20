// FIX: Corrected import path to traverse up 3 levels to root/data/
// FIX: Changed named import to default import to match worldGraph.js export
import worldGraph from '../../../data/worldGraph.js';

// --- Scoring Constants ---
const DEFAULT_IDLE_SCORE = 0.1; 
const DEFAULT_WANDER_SCORE = 1.0; 
const GOAL_MATCH_BOOST_FACTOR = 30.0;
const MAX_PERCEIVED_AGENTS = 20; 

function log(message) {}

// --- CACHING SYSTEM ---
// Cache perception results to avoid O(N^2) every tick
const CACHE_TTL = 5; // Re-scan every 5 ticks

export function analyzeSocialContext(agent, worldState) {
    const currentTick = worldState.currentTick || 0;

    // 1. Check Cache
    if (agent._perceptionCache && (currentTick - agent._perceptionCache.tick) < CACHE_TTL) {
        return agent._perceptionCache.data;
    }

    if (!worldState.locationSocialContext || !agent.locationId) {
        return { friendsNearby: 0, enemiesNearby: 0, isAlone: true, totalAgents: 1, perceivedAgents: [] };
    }

    const agentStubsAtLocation = worldState.locationSocialContext.get(agent.locationId) || [];
    let candidates = agentStubsAtLocation.filter(a => a.id !== agent.id);
    const totalAgents = candidates.length + 1; 

    // Smart Cap (Prioritize known contacts)
    if (candidates.length > MAX_PERCEIVED_AGENTS) {
        const knownAgents = [];
        const strangers = [];
        
        for (const stub of candidates) {
            const rel = (agent.relationships ?? {})[stub.id];
            if (rel && (rel.affinity > 10 || rel.type === 'partner' || rel.type === 'friend')) {
                knownAgents.push(stub);
            } else {
                strangers.push(stub);
            }
        }
        candidates = knownAgents.slice(0, MAX_PERCEIVED_AGENTS);
        if (candidates.length < MAX_PERCEIVED_AGENTS) {
            const slots = MAX_PERCEIVED_AGENTS - candidates.length;
            candidates = candidates.concat(strangers.slice(0, slots));
        }
    }

    let friends = 0;
    let enemies = 0;
    const perceivedAgents = [];

    for (const otherAgent of candidates) {
        const rel = (agent.relationships ?? {})[otherAgent.id];
        const affinity = rel?.affinity ?? 0;

        if (affinity > 50) friends++;
        else if (affinity < 0) enemies++;
        
        let relType = rel?.type ?? 'acquaintance';
        if (affinity > 50) relType = 'friend';
        if (affinity < 0) relType = 'rival';
        if (otherAgent.id === agent.partnerId) relType = 'partner';
        
        perceivedAgents.push({
            id: otherAgent.id,
            name: otherAgent.name,
            relationship: relType,
            affinity: affinity,
            state: otherAgent.state,
            activity: otherAgent.currentActivityName,
            mood: otherAgent.mood,
            stress: otherAgent.stress
        });
    }

    const result = { 
        friendsNearby: friends, 
        enemiesNearby: enemies, 
        isAlone: totalAgents <= 1,
        totalAgents: totalAgents, 
        perceivedAgents: perceivedAgents
    };

    // Save to Agent Cache
    agent._perceptionCache = { tick: currentTick, data: result };
    
    return result;
}

export function analyzeCrowding(agent, context) {
    // Crowding is cheap to calc, no cache needed usually
    const count = context.locationAgentCount[agent.locationId] || 0;
    const capacity = context.currentLocation?.capacity ?? 100;

    if (capacity <= 0) return { crowdingFactor: 0, perceivedCrowding: 'empty' }; 

    const crowdingFactor = count / capacity;
    let perceivedCrowding = 'comfortable';

    if (crowdingFactor < 0.1) perceivedCrowding = 'empty';
    if (crowdingFactor > 0.5) perceivedCrowding = 'busy';
    if (crowdingFactor > 0.8) perceivedCrowding = 'packed';

    const { extroversion, stressProneness } = agent.persona;

    if (crowdingFactor > 0.5) {
        if (extroversion > 0.7) perceivedCrowding = 'energetic';
        if (extroversion < 0.3 || stressProneness > 0.7) perceivedCrowding = 'overwhelming';
    }

    return { crowdingFactor, perceivedCrowding };
}

export function isActivityOverused(agent, activityName) {
    const history = agent.recentActivities ?? [];
    const isRequiredState = activityName === 'fsm_sleeping' || 
                            activityName.startsWith('fsm_working_') || 
                            activityName === 'fsm_eating' ||
                            activityName === 'fsm_maintenance' || 
                            activityName === 'fsm_shopping' ||
                            activityName === 'fsm_desperate'; // Don't limit desperation
    
    if (isRequiredState) return false;
    
    let nonEssentialCount = 0;
    for (const recentState of history) {
        const stateIsRequired = recentState === 'fsm_sleeping' || 
                                recentState.startsWith('fsm_working_') || 
                                recentState === 'fsm_eating' || 
                                recentState === 'fsm_maintenance' || 
                                recentState === 'fsm_shopping';
        if (!stateIsRequired) {
            nonEssentialCount++;
            if (recentState === activityName && nonEssentialCount <= 3) return true; 
        }
    }
    return false;
}

// FIX: Ensure explicit array return
export function getFallbackActions(agent, context, potentialActions) {
    // Mutation is fine, but we guarantee array return
    const actions = potentialActions || []; 
    
    actions.push({ 
        name: 'fsm_idle', 
        score: DEFAULT_IDLE_SCORE, 
        priority: context.PRIORITY_IDLE, 
        target: agent.locationId, 
        reason: 'Content',
        detailedReason: 'nothing pressing to do'
    });
    
    if (worldGraph && worldGraph.findRandomLocation) {
        const wanderTarget = worldGraph.findRandomLocation(context.currentLocation?.borough || 'manhattan');
        if (wanderTarget && (context.locationAgentCount[wanderTarget.key] || 0) < (wanderTarget.capacity ?? Infinity)) {
            actions.push({ 
                name: 'fsm_idle', 
                score: DEFAULT_WANDER_SCORE, 
                priority: context.PRIORITY_IDLE,
                target: wanderTarget.key, 
                reason: 'Just walking',
                detailedReason: 'feeling restless, want to explore'
            });
        }
    }
    return actions;
}

// FIX: Ensure explicit array return
export function applyTimeAdjustments(agent, context, potentialActions) {
    if (!Array.isArray(potentialActions)) return []; 

    const { isLateNight, isWorkShift, persona, dayOfWeek, hour, currentTick, currentLocationKey } = context;
    const { conscientiousness } = persona;

    const activeRoutines = (agent.routines || []).filter(routine => {
        const inHourRange = hour >= routine.hourRange[0] && hour < routine.hourRange[1];
        return routine.dayOfWeek === dayOfWeek && inHourRange && (routine.strength || 0) > 0.05;
    });

    const activeHabits = (agent.contextualRoutines || []).filter(habit => 
        habit.triggeredBy === 'location' && habit.locationId === currentLocationKey
    );

    return potentialActions.map(action => {
        let newScore = action.score ?? 0;
        let newReason = action.detailedReason;

        let routineBonus = 0;
        for (const routine of activeRoutines) {
            if (routine.activity === action.name && routine.location === action.target) {
                routineBonus += 300 * (routine.strength || 0.1);
                newReason += ` (Habit: Routine +${routineBonus.toFixed(0)})`;
            }
        }
        for (const habit of activeHabits) {
            if (habit.activity === action.name && habit.locationId === action.target) {
                routineBonus += 250 * (habit.strength || 0.1);
                newReason += ` (Habit: Location +${routineBonus.toFixed(0)})`;
            }
        }
        newScore += routineBonus;

        if (isLateNight && action.name !== 'fsm_sleeping' && !isWorkShift) { 
            newScore *= 0.05; 
            newReason += ` (too late)`;
        }

        if (isLateNight && action.name === 'fsm_sleeping') {
            newScore *= 2.0; 
        }

        if (isWorkShift && agent.locationId !== agent.workLocationId) {
            if (['fsm_socializing', 'fsm_recreation', 'fsm_maintenance'].includes(action.name)) {
                newScore *= (1.0 - conscientiousness); 
                newReason += ` (slacking off)`;
            }
        }
        
        return { ...action, score: newScore, detailedReason: newReason };
    });
}

// FIX: Ensure explicit array return
export function applyHysteresis(agent, potentialActions) {
    if (!Array.isArray(potentialActions)) return []; // Defensive check

    return potentialActions.map(a => {
        if (a.name === agent.state) {
            return { ...a, score: (a.score ?? 0) * 1.3, detailedReason: a.detailedReason + ' (inertia)' };
        }
        return a;
    });
}

function getActiveIntention(agent) {
    if (!agent.intentionStack || agent.intentionStack.length === 0) return null;
    return agent.intentionStack[agent.intentionStack.length - 1];
}

// FIX: Ensure explicit array return
export function applyGoalFiltering(agent, potentialActions) {
    if (!Array.isArray(potentialActions)) return []; // Defensive check
    
    const intention = getActiveIntention(agent);
    if (!intention || intention.suspended) return potentialActions;

    const goal = intention.goal;
    const target = intention.target;

    return potentialActions.map(action => {
        if (action.name === goal && action.target === target) {
            const newScore = (action.score ?? 0) * GOAL_MATCH_BOOST_FACTOR;
            const newReason = `${action.detailedReason} (**INTENTION MATCH**)`;
            return { ...action, score: newScore, detailedReason: newReason };
        }
        
        if (action.name === 'fsm_commuting' && action.target === target) {
             const newScore = (action.score ?? 0) * GOAL_MATCH_BOOST_FACTOR;
             const newReason = `${action.detailedReason} (**INTENTION STEP**)`;
             return { ...action, score: newScore, detailedReason: newReason };
        }

        return action;
    });
}