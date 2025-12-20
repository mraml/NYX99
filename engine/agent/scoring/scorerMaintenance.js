// FIX: Corrected import path to traverse up 3 levels to root/data/
// FIX: Changed named import to default import to match worldGraph.js export
import worldGraph from '../../../data/worldGraph.js';
import { GAME_BALANCE } from '../../../data/balance.js'; 

/**
 * Scores the need for home maintenance/cleaning.
 * FIX: Restored function signature to match actionScorer.js expectation.
 */
export function scoreMaintenance(agent, context, potentialActions) {
    if (!worldGraph?.nodes) return;
    
    const { persona } = context;
    // Default to average if persona missing
    const conscientiousness = persona?.conscientiousness ?? 0.5; 
    
    // Check if we are at home (context.currentLocation is the node agent is currently at)
    const isAtHome = agent.homeLocationId && agent.locationId === agent.homeLocationId;
    const homeNode = isAtHome ? context.currentLocation : null;

    let maintenanceScore = 0;
    let maintenanceReasoning = [];

    // Logic: Only score if at home and condition is poor
    if (homeNode && (homeNode.condition ?? 100) < 60) { 
        const conditionPenalty = (100 - (homeNode.condition ?? 100)) / 100;
        const baseScore = GAME_BALANCE?.SCORES?.MAINTENANCE_BASE || 10;
        
        maintenanceScore = (conditionPenalty) * baseScore * 2.0;
        
        // Personality Multiplier: Conscientious agents care more
        maintenanceScore *= conscientiousness * 1.5;
        
        maintenanceReasoning.push(`home in bad shape (${Math.round(homeNode.condition ?? 100)}% condition)`);
        
        if (conscientiousness > 0.6) {
            maintenanceReasoning.push(`conscientious cleanup`);
        }
        
        potentialActions.push({ 
            name: 'fsm_maintenance', 
            score: maintenanceScore, 
            priority: context.PRIORITY_LOW,
            target: agent.homeLocationId, 
            expectedDuration: 1, // Cleaning takes ~1 hour
            reason: 'Home is a mess',
            detailedReason: maintenanceReasoning.join(', ')
        });
    }
}