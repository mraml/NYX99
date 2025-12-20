import { scoreSleep, scoreEatAndShop, scoreWork, scoreAcquireHousing, scoreHealthcare } from './agent/scoring/scorerNeeds.js';
import { scoreRelationshipGoals, scoreSocialAndBoredom } from './agent/scoring/scorerSocioEmotional.js';
import { scoreMaintenance } from './agent/scoring/scorerMaintenance.js';
import * as ScorerContext from './agent/scoring/scorerContext.js';
import worldGraph from '../data/worldGraph.js';
import logger from '../logger.js';
import { generateDailyPlan } from './planningService.js';
import { isAgentWorkShift } from './agentUtilities.js'; 
import { GAME_BALANCE } from '../data/balance.js';
import { PriorityQueue } from './structures/PriorityQueue.js';

const SCORER_CONFIG = {
    // Priorities
    PRIORITY: {
        EMERGENCY: 100,
        HIGH: 80,
        MEDIUM: 50,
        LOW: 20,
        IDLE: 0
    },
    
    // Timeouts & Limits
    INTENTION_TIMEOUT_TICKS: 24 * 3,
    CRITICAL_ENERGY_THRESHOLD: 5,   
    PLANNING_ENERGY_THRESHOLD: 25, 
    COLLAPSE_SCORE: 9999,
    
    // Circadian Definitions (Should align with BaseState config)
    TIME: {
        LATE_NIGHT_START: 23,
        LATE_NIGHT_END: 5,
        WORK_START_DEFAULT: 9,
        WORK_END_DEFAULT: 17
    }
};

/**
 * Score Actions v2.0
 * The central brain that decides what an agent wants to do next.
 * FIX: Renamed back to getAgentGoal to match Worker Service expectation.
 * FIX: Restored legacy argument signature.
 */
export function getAgentGoal(agent, hour, locationAgentCount = {}, localEnv = {}, locationState = {}, worldState = {}) {
    if (!agent) return null;

    // FIX: Context Assembly - Inline (Builds the context object manually since the helper doesn't exist)
    const currentTick = worldState.currentTick || 0;
    
    // Fallback for hour if undefined
    if (hour === undefined || hour === null) {
        hour = agent.matrix?.worldTime ? agent.matrix.worldTime.getHours() : 12;
    }

    const fullContext = {
        hour,
        currentTick,
        dayOfWeek: worldState.dayOfWeek || 0,
        // Circadian Logic
        isLateNight: hour >= SCORER_CONFIG.TIME.LATE_NIGHT_START || hour < SCORER_CONFIG.TIME.LATE_NIGHT_END,
        isMealTime: (hour >= 7 && hour <= 9) || (hour >= 12 && hour <= 14) || (hour >= 18 && hour <= 20),
        isBusinessOpen: hour >= 8 && hour < 22,
        isWorkShift: isAgentWorkShift(agent, hour),
        
        // World Data
        currentLocationKey: agent.locationId,
        currentLocation: worldGraph.nodes[agent.locationId],
        locationAgentCount,
        weather: worldState.weather || {},
        
        // Agent Data
        thresholds: agent.thresholds || {},
        persona: agent.persona || {},
        
        // Priorities
        PRIORITY_EMERGENCY: SCORER_CONFIG.PRIORITY.EMERGENCY,
        PRIORITY_HIGH: SCORER_CONFIG.PRIORITY.HIGH,
        PRIORITY_MEDIUM: SCORER_CONFIG.PRIORITY.MEDIUM,
        PRIORITY_LOW: SCORER_CONFIG.PRIORITY.LOW,
        PRIORITY_IDLE: SCORER_CONFIG.PRIORITY.IDLE,
        
        // Social (Expensive calc)
        socialContext: ScorerContext.analyzeSocialContext(agent, worldState)
    };

    const potentialActions = new PriorityQueue((a, b) => b.score - a.score);

    try {
        // --- SCORING MODULES ---
        
        // Biological / Physiological (Maslow Base)
        scoreSleep(agent, fullContext, potentialActions);
        scoreEatAndShop(agent, fullContext, potentialActions);
        scoreHealthcare(agent, fullContext, potentialActions); 
        
        // Safety / Resources
        scoreAcquireHousing(agent, fullContext, potentialActions);
        scoreWork(agent, fullContext, potentialActions); 
        
        // Socio-Emotional (Consolidated)
        scoreRelationshipGoals(agent, fullContext, potentialActions);
        scoreMaintenance(agent, fullContext, potentialActions);
        scoreSocialAndBoredom(agent, fullContext, potentialActions); 

        // 2. Add Fallback Idle
        potentialActions.push({ 
            name: 'fsm_idle', 
            score: 0.1, 
            priority: SCORER_CONFIG.PRIORITY.IDLE, 
            target: agent.locationId, 
            reason: 'Idle',
            detailedReason: 'Default state' 
        });

        // 3. Select Best Action
        let actionsArray = potentialActions.toArray();

        // Apply post-processing filters
        actionsArray = ScorerContext.applyHysteresis(agent, actionsArray);
        actionsArray = ScorerContext.applyGoalFiltering(agent, actionsArray);
        
        // Re-sort after filters modified scores
        actionsArray.sort((a, b) => b.score - a.score);
        
        const bestAction = actionsArray[0];

        if (!bestAction) {
            return { goal: 'fsm_idle', target: agent.locationId, reason: 'Emergency Fallback', score: 0 };
        }

        return {
          goal: bestAction.name,
          target: bestAction.target,
          reason: bestAction.reason,
          score: bestAction.score,
          detailedReason: bestAction.detailedReason,
          expectedDuration: bestAction.expectedDuration
        };

    } catch (err) {
        logger.error(`[SCORER CRASH] Agent ${agent.name}: ${err.message}`, { stack: err.stack });
        // Fail gracefully to Idle
        return { goal: 'fsm_idle', target: agent.locationId, reason: 'Scorer Error', score: 0 };
    }
}