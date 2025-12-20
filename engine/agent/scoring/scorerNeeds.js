// FIX: Corrected import path to traverse up 3 levels to root/data/
import worldGraph from '../../../data/worldGraph.js';
import { GAME_BALANCE } from '../../../data/balance.js';
import { sigmoid, urgency, MASLOW } from './utility.js';
import logger from '../../../logger.js';

/**
 * SCORER TUNING CONFIGURATION
 * Centralized magic numbers for easier behavior balancing.
 */
const SCORER_CONSTANTS = {
    HABITS: {
        MAX_EFFECTIVE_COUNT: 10,
        BASE_BONUS: 0.05,
        BOREDOM_PENALTY_FACTOR: 0.6,
    },
    TRAVEL: {
        BASE_PENALTY: 0.05,
        CRITICAL_ENERGY_PENALTY: 3.0,
        LOW_ENERGY_PENALTY: 1.5,
        WORK_COMMUTE_PENALTY: 2.5,
        HOME_COMMUTE_PENALTY: 1.2,
    },
    HEALTHCARE: {
        HYPOCHONDRIAC_THRESHOLD: 0.7,
        HYPOCHONDRIAC_CHANCE: 0.05,
        BASE_MULT: 1.5,
        SICK_NEUROTIC_MULT: 2.0
    }
};

/**
 * Helper: Find the best target location based on distance and context.
 */
function findSmartTarget(agent, context, actionType, categoryType) {
    // 1. Check Affordance Cache first (O(1))
    if (worldGraph.affordanceCache?.[actionType]?.[agent.locationId]) {
        const cachedKey = worldGraph.affordanceCache[actionType][agent.locationId];
        return worldGraph.nodes[cachedKey];
    }
    // 2. Fallback to random (O(N) or O(1) depending on implementation)
    return worldGraph.findRandomLocationByType(categoryType || 'store');
}

/**
 * Helper: Calculate travel penalty score reduction.
 */
function calculateTravelPenalty(agent, targetId, context) {
    if (agent.locationId === targetId) return 1.0; // No penalty

    const dist = worldGraph.getDistance(agent.locationId, targetId);
    let penalty = SCORER_CONSTANTS.TRAVEL.BASE_PENALTY * dist;

    // Contextual Penalties
    if ((agent.energy ?? 100) < 30) penalty *= SCORER_CONSTANTS.TRAVEL.CRITICAL_ENERGY_PENALTY;
    else if ((agent.energy ?? 100) < 50) penalty *= SCORER_CONSTANTS.TRAVEL.LOW_ENERGY_PENALTY;

    return Math.max(0.1, 1.0 - penalty);
}

// ============================================================================
// NEED SCORERS
// ============================================================================

export function scoreAcquireHousing(agent, context, potentialActions) {
    // Only for homeless agents
    if (agent.homeLocationId) return;

    // Urgency increases as money increases (optimism) and energy decreases (desperation)
    const moneyFactor = Math.min(1, (agent.money || 0) / 1500); // 1.0 at $1500
    const desperation = (100 - (agent.energy || 0)) / 100;
    
    // Base score is SAFETY (high priority)
    const score = MASLOW.SAFETY * (moneyFactor * 0.7 + desperation * 0.3);

    if (score > 100) {
         // Find a home
         const vacancy = findSmartTarget(agent, context, 'fsm_acquire_housing', 'home'); 
         // Note: In a real sim, we'd need to find *vacant* homes, but for now we just find 'home' nodes
         // that might have leasing offices.
         
         if (vacancy) {
             potentialActions.push({
                name: 'fsm_acquire_housing',
                score: score,
                priority: context.PRIORITY_HIGH,
                target: vacancy.key || vacancy.id,
                reason: 'Homeless',
                detailedReason: 'Seeking shelter'
            });
         }
    }
}

export function scoreSleep(agent, context, potentialActions) {
    const energy = agent.energy ?? 100;
    const fatigue = 100 - energy;
    
    // FIX [P7] Scoring Context: Personality & Sigmoids
    // Instead of "If Energy < 20", we use a curve that shifts based on traits.
    
    // Base Midpoint: 70 fatigue (30 energy)
    let midpoint = 70; 
    
    // Personality Variance
    const traits = agent.persona?.traits || [];
    if (traits.includes('Lazy')) midpoint = 50;       // Feels tired sooner (at 50 fatigue)
    if (traits.includes('Energetic')) midpoint = 85;  // Pushes through until 85 fatigue
    if (traits.includes('Night Owl') && !context.isLateNight) midpoint += 10; // Resists sleep during day

    // Calculate Curve
    // Steepness (k) = 0.15 gives a nice organic transition, not a cliff
    let sleepUrgency = sigmoid(fatigue, 0.15, midpoint);
    
    // Contextual Multipliers
    if (agent.homeLocationId && agent.locationId === agent.homeLocationId) {
        sleepUrgency *= 1.2; // Easier to feel sleepy at home
    }
    
    // Hard override for biological failure (Passing out)
    if (energy <= 5) sleepUrgency = 10.0; // Force immediate action

    const score = MASLOW.PHYSIOLOGICAL * sleepUrgency;

    if (score > 50) {
        const target = agent.homeLocationId || agent.locationId; // Sleep where you are if homeless
        const isHome = target === agent.homeLocationId;
        
        potentialActions.push({
            name: 'fsm_sleeping',
            score: score,
            priority: energy < 10 ? context.PRIORITY_EMERGENCY : context.PRIORITY_HIGH,
            target: target,
            reason: 'Tired',
            detailedReason: isHome ? 'Sleeping in bed' : 'Sleeping on bench'
        });
    }
}

export function scoreEatAndShop(agent, context, potentialActions) {
    const hunger = agent.hunger ?? 0;
    
    // FIX [P7] Scoring Context: Personality & Sigmoids
    // Remove "Cliff Edge" logic (e.g. if hunger > 80)
    
    // Base Midpoint: 50 hunger
    let midpoint = 50;
    
    const traits = agent.persona?.traits || [];
    if (traits.includes('Foodie')) midpoint = 35; // Gets hungry sooner
    if (traits.includes('Ascetic')) midpoint = 70; // Ignores hunger longer
    
    // Meal Times (Circadian Entrainment)
    // We gently lower the midpoint during meal hours to encourage syncing
    if (context.isMealTime) midpoint -= 15;

    // Calculate Curve
    const hungerUrgency = sigmoid(hunger, 0.12, midpoint);
    const score = MASLOW.PHYSIOLOGICAL * hungerUrgency;

    // Only suggest action if the score is meaningful
    if (score > 100) {
        // Decide: Groceries (Home) vs Restaurant (Out)
        // Rich/Lazy agents prefer restaurants. Poor/Cooks prefer groceries.
        // FIX: Ensure money is a Number to prevent string comparison bugs ("1000" < 500 = false)
        const money = Number(agent.money) || 0;
        
        // Debug Trap: If agent is desperate but system thinks they are broke, Log it.
        if (score > 200 && money < 10 && (agent.money !== undefined)) {
            logger.warn(`Agent ${agent.id} starvation risk. Hunger: ${hunger.toFixed(0)}, Money Value: ${agent.money} (Type: ${typeof agent.money})`);
        }

        const preferRestaurant = (money > 500 && Math.random() > 0.3) || traits.includes('Foodie');
        
        // BUG FIX: Check for !isSpoiled. Otherwise agents loop on rotten food.
        const hasFoodAtHome = (agent.inventory || []).some(i => i.type === 'food' && !i.isSpoiled);

        let targetType = 'restaurant';
        let actionName = 'fsm_eating';

        if (hasFoodAtHome && !preferRestaurant && agent.homeLocationId) {
            // Go home to eat
            potentialActions.push({
                name: 'fsm_eating',
                score: score * 1.1, // Bonus for thriftiness
                priority: context.PRIORITY_MEDIUM,
                target: agent.homeLocationId,
                reason: 'Hungry',
                detailedReason: 'Eating at home'
            });
            return;
        } else if (!hasFoodAtHome && !preferRestaurant) {
            // Needs groceries
            // FIX: Changed 'grocery' to 'store' to match locations.yaml definition
            targetType = 'store';
            actionName = 'fsm_shopping';
        }

        // Find external target
        const target = findSmartTarget(agent, context, actionName, targetType);
        
        if (target) {
            const travelFactor = calculateTravelPenalty(agent, target.key, context);
            potentialActions.push({
                name: actionName,
                score: score * travelFactor,
                priority: context.PRIORITY_MEDIUM,
                target: target.key,
                reason: 'Hungry',
                detailedReason: `Going to ${targetType}`
            });
        }
    }
}

export function scoreWork(agent, context, potentialActions) {
    if (!agent.job || agent.job.title === 'Unemployed') return;

    // Strict Schedule: High Score during shift
    if (context.isWorkShift) {
        // Burnout Logic: High burnout reduces work score (Absenteeism)
        const burnout = agent.burnout ?? 0;
        // Sigmoid: Burnout > 80 creates massive resistance
        const burnoutResistance = sigmoid(burnout, 0.2, 80); 
        
        let score = MASLOW.SAFETY * 2.0 * (1.0 - burnoutResistance);

        // Personality Logic
        const conscientiousness = agent.persona?.conscientiousness ?? 0.5;
        score *= (0.8 + (conscientiousness * 0.4)); // 0.8x to 1.2x multiplier

        const target = agent.workLocationId;
        if (target) {
            potentialActions.push({
                name: 'fsm_working_office', // Default, assumes office for now
                score: score,
                priority: context.PRIORITY_HIGH,
                target: target,
                reason: 'Work Shift',
                detailedReason: 'Scheduled shift'
            });
        }
    }
}

export function scoreHealthcare(agent, context, potentialActions) {
    const isSick = (agent.status_effects ?? []).some(e => e?.type === 'SICK');
    const neuroticism = agent.persona?.neuroticism ?? 0.5;
    const C = SCORER_CONSTANTS.HEALTHCARE;
    
    // Neurotic agents might hallucinate sickness/worry
    const isHypochondriac = neuroticism > C.HYPOCHONDRIAC_THRESHOLD && Math.random() < C.HYPOCHONDRIAC_CHANCE;
    
    if (isSick || isHypochondriac) {
        let healthScore = MASLOW.SAFETY * C.BASE_MULT;
        if (isSick && neuroticism > 0.6) healthScore *= C.SICK_NEUROTIC_MULT;

        let reasoning = isSick ? 'Sick' : 'Health anxiety';
        
        if ((agent.money ?? 0) > 50) {
            const clinicTarget = findSmartTarget(agent, context, 'fsm_seek_healthcare', 'clinic');
            // Fallback if smart target fails
            const target = clinicTarget ? clinicTarget.key : worldGraph.findRandomLocationByType('clinic')?.key;
            
            if (target) {
                const travelPenalty = calculateTravelPenalty(agent, target, context);
                // Sick agents hate travel exponentially
                const sickTravelFactor = Math.pow(travelPenalty, 2);
                
                potentialActions.push({
                    name: 'fsm_seek_healthcare',
                    score: healthScore * sickTravelFactor,
                    priority: context.PRIORITY_HIGH,
                    target: target,
                    expectedDuration: 2,
                    reason: 'Healthcare',
                    detailedReason: reasoning
                });
            }
        }
    }
}