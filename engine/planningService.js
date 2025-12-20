import worldGraph from '../data/worldGraph.js';

/**
 * engine/planningService.js
 * Generates a high-level, multi-step daily plan for an agent.
 * NOW WITH PREDICTIVE LOGIC.
 */

const missingCacheWarnings = new Set();
const TRAVEL_BUFFER = 0.5; // 30 minutes allowed for travel between locations

// Helper to find a suitable location for an activity
function findLocationForActivity(agent, startLocationId, activityTag) {
    if (agent.habits && agent.habits[activityTag]) {
        const bestHabit = Object.entries(agent.habits[activityTag])
            .sort((a, b) => b[1] - a[1])[0];
        if (bestHabit) return bestHabit[0];
    }

    if (worldGraph && worldGraph.affordanceCache && worldGraph.affordanceCache[activityTag]) {
        const targetLocationId = worldGraph.affordanceCache[activityTag][startLocationId];
        if (targetLocationId) return targetLocationId;
    }

    // Global Fallback
    if (worldGraph && worldGraph.nodes) {
        let targetType = [];
        if (activityTag === 'fsm_economy_shopping') targetType = ['grocery', 'supermarket', 'convenience'];
        else if (activityTag === 'fsm_bio_eating') targetType = ['restaurant', 'diner', 'cafe'];
        else if (activityTag === 'fsm_social_gathering') targetType = ['bar', 'club', 'park', 'cafe'];
        else if (activityTag === 'fsm_leisure_recreation') targetType = ['park', 'gym', 'library', 'cinema'];
        
        if (targetType.length > 0) {
            const fallback = Object.values(worldGraph.nodes).find(n => targetType.includes(n.type));
            if (fallback) return fallback.key;
        }
    }
    
    return null;
}

/**
 * Checks if a proposed time slot collides with existing plans.
 * Applies a TRAVEL_BUFFER if the locations differ.
 */
function hasCollision(plan, startTime, duration, targetLocationId) {
    const endTime = startTime + duration;
    
    for (const item of plan) {
        // Calculate required buffer: if locations match, 0; otherwise, travel time needed.
        const bufferNeeded = (item.target !== targetLocationId) ? TRAVEL_BUFFER : 0;
        
        // Check buffer for NewItem relative to ExistingItem
        const bufferForNew = (item.target !== targetLocationId) ? TRAVEL_BUFFER : 0;
        
        if (startTime < (item.endTime + bufferForNew) && (endTime + bufferForNew) > item.startTime) {
            return true;
        }
    }
    return false;
}

/**
 * Tries to add an activity to the plan. Returns true if successful.
 */
function tryAddActivity(plan, agent, activityData) {
    const { goal, target, startTime, duration, priority, context } = activityData;
    
    if (hasCollision(plan, startTime, duration, target)) {
        // console.warn(`[Planner] Collision detected for ${goal} at ${startTime}. Skipping.`);
        return false;
    }

    plan.push({
        goal,
        target,
        startTime,
        duration,
        endTime: startTime + duration,
        priority,
        context
    });
    return true;
}

export function generateDailyPlan(agent) {
    const plan = [];
    const homeLocationId = agent.homeLocationId;
    
    if (!homeLocationId) return []; 

    const worldTime = agent.matrix?.worldTime;
    const dayOfWeek = worldTime ? worldTime.getDay() : 1; 
    const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6); 
    
    // Status Checks
    const isSick = (agent.status_effects ?? []).some(e => e?.type === 'SICK');
    const isBurntOut = (agent.burnout ?? 0) > 85;
    
    // --- 1. SICK DAY (Override) ---
    if (isSick) {
        tryAddActivity(plan, agent, {
            goal: 'fsm_bio_sleeping', // Standardized name
            target: homeLocationId,
            startTime: 0,
            duration: 24,
            priority: 90,
            context: { detailedReason: "Sick day." }
        });
        return plan;
    }

    // --- 2. CALCULATE WAKE/SLEEP CYCLE ---
    let wakeTime = agent.circadianBias || 7; 
    const workStart = agent.job?.startHour ?? 9;
    const hasWork = !isWeekend && !isBurntOut && agent.job && agent.job.title !== 'Unemployed';

    if (hasWork) {
        wakeTime = Math.max(0, workStart - 2);
    }
    
    // Use 24+ hour format
    let sleepTime = wakeTime + 16;
    if (sleepTime < 20) sleepTime = 22;

    tryAddActivity(plan, agent, {
        goal: 'fsm_bio_sleeping', // Standardized name
        target: homeLocationId,
        startTime: sleepTime,
        duration: 8, // Assume 8 hours sleep
        priority: 80,
        context: { detailedReason: "Planned bedtime." }
    });

    // --- 3. WORK BLOCK & LUNCH ---
    let lastActivityEnd = wakeTime;

    if (hasWork) {
        const workEnd = agent.workEndHour ?? 17;
        const workLocationId = agent.workLocationId;
        const workGoal = `fsm_work_${agent.job.title.toLowerCase().replace(/[^a-z0-9]/g, '_')}`; // Dynamic work state

        if (workLocationId) {
            // Predictive Lunch Logic
            const lunchTime = Math.floor(workStart + (workEnd - workStart) / 2);
            const lunchDuration = 1;
            const lunchSpot = findLocationForActivity(agent, workLocationId, 'fsm_bio_eating'); // Standardized name
            
            if (lunchSpot) {
                // Work Part 1
                tryAddActivity(plan, agent, {
                    goal: workGoal,
                    target: workLocationId,
                    startTime: workStart,
                    duration: lunchTime - workStart,
                    priority: 50,
                    context: { detailedReason: "Morning shift." }
                });

                // Lunch
                tryAddActivity(plan, agent, {
                    goal: 'fsm_bio_eating', // Standardized name
                    target: lunchSpot,
                    startTime: lunchTime,
                    duration: lunchDuration,
                    priority: 60,
                    context: { detailedReason: "Lunch break." }
                });

                // Work Part 2
                tryAddActivity(plan, agent, {
                    goal: workGoal,
                    target: workLocationId,
                    startTime: lunchTime + lunchDuration,
                    duration: workEnd - (lunchTime + lunchDuration),
                    priority: 50,
                    context: { detailedReason: "Afternoon shift." }
                });
            } else {
                // No lunch planned, straight work
                tryAddActivity(plan, agent, {
                    goal: workGoal,
                    target: workLocationId,
                    startTime: workStart,
                    duration: workEnd - workStart,
                    priority: 50,
                    context: { detailedReason: "Going to work." }
                });
            }
        }
        lastActivityEnd = workEnd;
    }

    // --- 4. PREDICTIVE NEEDS (Shopping) ---
    const groceries = (agent.inventory?.groceries || 0);
    const needsGroceries = groceries < 3;
    const canAffordGroceries = (agent.money ?? 0) > 30;

    if (needsGroceries && canAffordGroceries) {
        const shopSpot = findLocationForActivity(agent, homeLocationId, 'fsm_economy_shopping'); // Standardized name
        if (shopSpot) {
            const shopDuration = 1;
            const potentialStart = lastActivityEnd + (hasWork ? TRAVEL_BUFFER : 0.5); 
            
            const added = tryAddActivity(plan, agent, {
                goal: 'fsm_economy_shopping', // Standardized name
                target: shopSpot,
                startTime: potentialStart,
                duration: shopDuration,
                priority: 45,
                context: { detailedReason: "Restocking fridge." }
            });

            if (added) lastActivityEnd = potentialStart + shopDuration;
        }
    }

    // --- 5. PREDICTIVE MEALS (Dinner) ---
    let dinnerTime = Math.max(19, lastActivityEnd + TRAVEL_BUFFER);
    const dinnerDuration = 1.5;

    if (dinnerTime + dinnerDuration < sleepTime) {
        if (groceries > 0) {
            const added = tryAddActivity(plan, agent, {
                goal: 'fsm_bio_eating', // Standardized name
                target: homeLocationId,
                startTime: dinnerTime,
                duration: dinnerDuration,
                priority: 50,
                context: { detailedReason: "Cooking dinner." }
            });
            if (added) lastActivityEnd = dinnerTime + dinnerDuration;

        } else if ((agent.money ?? 0) > 20) {
            const dinnerSpot = findLocationForActivity(agent, homeLocationId, 'fsm_bio_eating'); // Standardized name
            if (dinnerSpot) {
                const added = tryAddActivity(plan, agent, {
                    goal: 'fsm_bio_eating', // Standardized name
                    target: dinnerSpot,
                    startTime: dinnerTime,
                    duration: dinnerDuration,
                    priority: 50,
                    context: { detailedReason: "Dinner out." }
                });
                if (added) lastActivityEnd = dinnerTime + dinnerDuration;
            }
        }
    }

    // --- 6. FILLER (Leisure/Social) ---
    scheduleFreeTime(agent, plan, lastActivityEnd + TRAVEL_BUFFER, sleepTime, homeLocationId);

    plan.sort((a, b) => a.startTime - b.startTime);
    return plan;
}

function scheduleFreeTime(agent, plan, startTime, endTime, currentLocationId) {
    if (endTime <= startTime) return;

    let currentTime = startTime;
    const p = agent.persona || {};
    const aspiration = agent.aspiration?.type;
    let iterations = 0; // Guard against infinite loops

    // Fill the time until sleep
    while (currentTime < endTime - 0.5 && iterations++ < 50) { // Leave 0.5hr buffer before sleep
        let chosenActivity = 'fsm_leisure_recreation'; // Standardized name
        let reason = "Relaxing.";
        let duration = 2; // Default duration
        
        const timeRemaining = endTime - currentTime - TRAVEL_BUFFER;

        // Safety: If remaining time is too short for a viable activity, break.
        if (timeRemaining < 0.5) { 
             break;
        }

        if (aspiration === 'MASTER_SKILL') {
            chosenActivity = 'fsm_leisure_recreation'; 
            reason = "Practice.";
        } else if (aspiration === 'BECOME_POPULAR') {
            chosenActivity = 'fsm_social_gathering'; // Standardized name
            reason = "Socializing.";
        } else {
            if ((p.extroversion ?? 0.5) > 0.6) {
                chosenActivity = 'fsm_social_gathering'; // Standardized name
                reason = "Hanging out.";
            } else {
                chosenActivity = 'fsm_leisure_recreation'; 
                reason = "Me-time.";
            }
        }
        
        // Dynamically size the activity to fit the remaining time, up to max duration (2 hours)
        duration = Math.min(duration, timeRemaining);
        
        // Ensure minimum duration (e.g., 1 hour) if activity chosen
        if (duration < 1) {
            break; 
        }

        const targetLoc = findLocationForActivity(agent, currentLocationId, chosenActivity);
        
        if (targetLoc) {
            const added = tryAddActivity(plan, agent, {
                goal: chosenActivity,
                target: targetLoc,
                startTime: currentTime,
                duration: duration,
                priority: 40,
                context: { detailedReason: reason, duration: duration }
            });
            
            if (added) {
                // Advance time by actual duration + potential travel buffer
                const timeAdvance = duration + ((targetLoc !== currentLocationId) ? TRAVEL_BUFFER : 0);
                currentTime += timeAdvance;
            } else {
                // If collision, skip forward
                currentTime += 0.5;
            }
        } else {
            // No location found for the activity, skip the default duration slot to find the next opening
            currentTime += duration;
        }
    }
}