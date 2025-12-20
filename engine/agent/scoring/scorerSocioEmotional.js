// FIX: Corrected import path to traverse up 3 levels to root/data/
import worldGraph from '../../../data/worldGraph.js';
import { GAME_BALANCE } from '../../../data/balance.js';
import { sigmoid, MASLOW } from './utility.js';
import { isAgentLateNight, isVenueClosingSoon } from '../../agentUtilities.js';

const BASE_SOCIAL_SCORE = GAME_BALANCE.SCORES.SOCIAL_BASE;
const BASE_NOVELTY_SCORE = GAME_BALANCE.SCORES.NOVELTY_BASE;

export function scoreRelationshipGoals(agent, context, potentialActions) {
    if (!worldGraph?.nodes) return;
    const { isSocialHours, hour } = context;

    // Don't socialize if it's too late or everything is closing
    if (isAgentLateNight(hour) || isVenueClosingSoon(hour)) return;

    // ... existing specific relationship logic would go here ...
    // (Keeping this function strictly for targeted relationship events, e.g. dates)
}

export function scoreSocialAndBoredom(agent, context, potentialActions) {
    const { hour } = context;
    const isLate = isAgentLateNight(hour);
    const closingSoon = isVenueClosingSoon(hour);

    // --- 1. SOCIAL SCORING (Loneliness) ---
    const socialNeed = agent.social ?? 0;
    const extroversion = agent.persona?.extroversion ?? 0.5;

    // FIX [P7]: Personality-Driven Sigmoid
    // Extroverts (1.0) get lonely faster (Midpoint 40)
    // Introverts (0.0) tolerate solitude longer (Midpoint 70)
    const socialMidpoint = 70 - (extroversion * 30);
    const socialUrgency = sigmoid(socialNeed, 0.15, socialMidpoint);

    const socialScore = MASLOW.LOVE * socialUrgency;

    if (socialScore > 50) {
        // Decide where to socialize
        // Extroverts prefer bars/parks. Introverts prefer home/quiet spots.
        let targetType = 'park';
        if (extroversion > 0.6 && !isLate) targetType = 'bar';
        if (isLate) targetType = agent.homeLocationId ? 'home' : 'park';

        // If at home and Introvert, socialize digitally or with family
        if (agent.locationId === agent.homeLocationId && extroversion < 0.4) {
             potentialActions.push({
                name: 'fsm_socializing',
                score: socialScore * 1.2, // Bonus for comfort zone
                priority: context.PRIORITY_MEDIUM,
                target: agent.homeLocationId,
                expectedDuration: 2,
                reason: 'Lonely',
                detailedReason: 'Texting friends / Family time'
            });
        } else {
            // Go out
            const target = worldGraph.findRandomLocationByType(targetType);
            if (target) {
                potentialActions.push({
                    name: 'fsm_socializing',
                    score: socialScore,
                    priority: context.PRIORITY_MEDIUM,
                    target: target.key,
                    expectedDuration: 3,
                    reason: 'Lonely',
                    detailedReason: `Meeting people at ${targetType}`
                });
            }
        }
    }

    // --- 2. BOREDOM SCORING (Novelty Seeking) ---
    const boredom = agent.boredom ?? 0;
    const openness = agent.persona?.openness ?? 0.5;

    // FIX [P7]: Personality-Driven Sigmoid
    // High Openness (1.0) gets bored very fast (Midpoint 40)
    // Low Openness (0.0) is content doing nothing (Midpoint 80)
    const boredomMidpoint = 80 - (openness * 40);
    const boredomUrgency = sigmoid(boredom, 0.15, boredomMidpoint);

    const boredomScore = MASLOW.ESTEEM * boredomUrgency; // Boredom acts on higher needs

    if (boredomScore > 60) {
        if (isLate || closingSoon) {
            // Nighttime boredom -> Passive recreation at home
            if (agent.homeLocationId) {
                potentialActions.push({
                    name: 'fsm_recreation',
                    score: boredomScore,
                    priority: context.PRIORITY_LOW,
                    target: agent.homeLocationId,
                    expectedDuration: 2,
                    reason: 'Bored',
                    detailedReason: 'TV / Reading / Gaming'
                });
            }
        } else {
            // Daytime boredom -> Active fun
            // High openness = Parks, Museums (Library). Low openness = Bar, Shopping.
            const preferredType = openness > 0.6 ? 'library' : 'bar';
            
            // Check cache or random
            let activityTarget = worldGraph.findRandomLocationByType(preferredType);
            
            if (activityTarget) {
                 potentialActions.push({
                    name: 'fsm_recreation',
                    score: boredomScore,
                    priority: context.PRIORITY_LOW,
                    target: activityTarget.key,
                    expectedDuration: 3,
                    reason: 'Bored',
                    detailedReason: `Going to ${preferredType}`
                });
            }
        }
    }
}