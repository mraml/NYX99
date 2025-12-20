import { BaseState } from './BaseState.js';
import { ACTIVITY_COSTS } from '../../data/dataLoader.js';
import eventBus from '../eventBus.js';

/**
 * MaintenanceState.js
 * Handles the transactional logic for 'fsm_maintenance'.
 * [REF] Stateless Flyweight Version
 */
export class MaintenanceState extends BaseState {
    
    // [REF] Added agent param
    enter(agent) {
        super.enter(agent);
        this._updateActivityFromState(agent);
        this.log(`[${agent.name}] Starting home maintenance/cleaning.`);
    }

    // [REF] Added agent param
    tick(agent, hour, localEnv, worldState) {
        // Apply passive need increases
        super.tick(agent, hour, localEnv, worldState);
        
        // === PERFORMANCE FIX ===
        // Update UI every 10 ticks (approx 30 mins game time)
        let isDirty = (worldState.currentTick % 10 === 0);
        let walOp = null;
        
        const homeNode = this._getHomeNode(agent); // [REF] Passed agent
        
        if (homeNode) {
            // Cost is per-tick.
            const baseCost = (ACTIVITY_COSTS['maintenance'] || 5); 

            // --- 1. Skill & Personality Impact ---
            const skillLevel = (agent.skills?.maintenance ?? 0) / 100;
            const diligence = agent.persona?.conscientiousness ?? 0.5;
            
            // Skilled agents repair 50% faster
            let repairAmount = 2 + (skillLevel * 2); 
            
            // Skilled agents use 50% less materials
            let costEfficiency = Math.max(0.5, 1.0 - (skillLevel * 0.5));
            
            // --- 2. Execution ---
            const actualCost = baseCost * costEfficiency;

            if ((agent.money ?? 0) >= actualCost) {
                agent.money = (agent.money ?? 0) - actualCost;
                
                // Cap condition at 100
                homeNode.condition = Math.min(100, (homeNode.condition ?? 100) + repairAmount);
                
                // Emotional effects
                const satisfaction = diligence > 0.6 ? 0.5 : 0.1;
                agent.mood = Math.min(100, (agent.mood ?? 0) + satisfaction);
                
                const stressRelief = diligence > 0.4 ? 0.5 : -0.1;
                agent.stress = Math.max(0, (agent.stress ?? 0) - stressRelief);
                
                // Log transaction occasionally
                if (isDirty) {
                    walOp = { op: 'AGENT_MAINTAIN_HOME', data: { cost: actualCost, newCondition: homeNode.condition } };
                }

                // --- 3. Flavor Events (5% chance) ---
                if (Math.random() < 0.05) {
                     const events = [
                        { text: "found a lost $10 bill under the sofa", money: 10, mood: 5 },
                        { text: "hit my thumb with a hammer", money: 0, mood: -10, stress: 10 },
                        { text: "fixed a leaky faucet", money: 0, mood: 2 },
                        { text: "scrubbed a stubborn stain", money: 0, mood: 1 },
                        { text: "realized the paint color is all wrong", money: 0, mood: -2 }
                    ];
                    const evt = events[Math.floor(Math.random() * events.length)];
                    
                    if (evt.money) agent.money += evt.money;
                    if (evt.mood) agent.mood = Math.min(100, Math.max(0, (agent.mood ?? 0) + evt.mood));
                    if (evt.stress) agent.stress = Math.min(100, (agent.stress ?? 0) + evt.stress);
                    
                    // Write significant moments to memory
                    if (Math.abs(evt.mood) > 5 || evt.money > 0) {
                        eventBus.emitNow('db:writeMemory', 'low', agent.id, worldState.currentTick, `While cleaning, I ${evt.text}.`);
                        if (agent.lod === 1) this.log(`[${agent.name}] ${evt.text}.`);
                    }
                }

                // Completion Check
                if (homeNode.condition >= 100) {
                    this.log(`[${agent.name}] Home is spotless. Stopping maintenance.`);
                    return { isDirty: true, walOp, nextState: 'fsm_idle' };
                }
            } else {
                // Failure: financial stress, exit state
                agent.stress = Math.min(100, (agent.stress ?? 0) + 5);
                this.log(`[${agent.name}] Can't afford repairs ($${actualCost.toFixed(2)} needed).`);
                
                eventBus.emitNow('db:writeMemory', 'medium', agent.id, worldState.currentTick, 
                    `I wanted to fix up the place, but I can't even afford the supplies.`);
                
                return { isDirty: true, walOp, nextState: 'fsm_idle' };
            }
        } else {
            // No home, exit state
            return { isDirty: true, walOp, nextState: 'fsm_idle' };
        }
        
        return { isDirty, walOp };
    }
}