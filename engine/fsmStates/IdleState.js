import { BaseState } from './BaseState.js';
import eventBus from '../eventBus.js';

/**
 * IdleState.js
 * Represents an agent doing nothing/waiting.
 * [REF] Stateless Flyweight Version
 * (MODIFIED: Removed hardcoded thought/activity strings.)
 */
export class IdleState extends BaseState {
    
    // [REF] Removed constructor(fsm)

    // [REF] Added agent param
    enter(agent) {
        super.enter(agent);
        this._updateActivityFromState(agent); // [REF] Passed agent
        // Only log if significant or LOD 1 to reduce spam
        if (agent.lod === 1) {
             this.log(`[${agent.name}] Is idle.`);
        }
    }

    // [REF] Added agent param as first arg
    tick(agent, hour, localEnv, worldState) {
        // Apply passive decay from BaseState
        // [REF] Pass agent to super
        super.tick(agent, hour, localEnv, worldState);

        // [REF] agent is now an argument, no longer this.agent
        
        // === PERFORMANCE FIX ===
        // Idling is low-priority. Only update UI every 10 ticks.
        let isDirty = (worldState.currentTick % 10 === 0);

        // --- 1. Boredom & Personality (The "Waiting" Factor) ---
        // Idling accelerates boredom decay, heavily influenced by personality.
        const patience = agent.persona?.conscientiousness ?? 0.5;
        const energy = agent.energy ?? 50;
        
        let boredomPenalty = 2.0; 
        
        // High Energy or Low Patience -> Bored/Stressed faster
        if (patience < 0.3 || energy > 80) {
            boredomPenalty *= 2.0;
            // Fidgeting: High energy idling causes slight stress
            if (energy > 80) {
                agent.stress = Math.min(100, (agent.stress ?? 0) + 0.05);
            }
        } else if (patience > 0.7) {
            // Patient/Chill people don't mind waiting
            boredomPenalty *= 0.5; 
            // Meditative: Patient idling reduces stress slightly
            agent.stress = Math.max(0, (agent.stress ?? 0) - 0.1);
        }
        
        agent.boredom = Math.max(0, (agent.boredom ?? 0) - boredomPenalty);

        // --- 2. People Watching (Environment Factor) ---
        const crowdCount = agent.perceivedAgents?.length || 0;
        
        if (crowdCount > 0) {
            // Watching people is mildly entertaining
            agent.boredom = Math.min(100, (agent.boredom ?? 0) + 0.5);
            
            // Extroverts gain social battery just by being near others
            if ((agent.persona?.extroversion ?? 0.5) > 0.6) {
                 agent.social = Math.min(100, (agent.social ?? 0) + 0.1);
            }
        }

        // --- 3. Daydreaming (Flavor Events) ---
        // 2% chance per tick to have a thought
        if (Math.random() < 0.02) { 
            // Removed hardcoded thoughts array
            
            // Only update UI/Log for significant agents
            if (agent.lod === 1) {
                // Log generic event marker instead of specific thought
                this.log(`[${agent.name}] Is deeply focused on something internal.`); 
                isDirty = true; 
            }
            
            // Rare chance to form a memory from idling
            if (Math.random() < 0.1) {
                 // Removed hardcoded memory string
                 eventBus.emitNow('db:writeMemory', 'low', agent.id, worldState.currentTick, `Had an internal thought or observation.`);
            }
        }

        // --- 4. Intention Check & Need Fulfillment ---
        // NEW: If we have no plan and we're idle, check for immediate critical needs
        if (!agent.intentionStack || agent.intentionStack.length === 0) {
            
            // Critical Need 1: Housing (Always highest priority if homeless)
            if (!agent.homeLocationId) {
                this.log(`[${agent.name}] Homeless and idle. Searching for housing.`);
                return { isDirty: true, nextState: 'fsm_acquire_housing' }; 
            }
            
            // Critical Need 2: Food
            if ((agent.hunger ?? 0) > 80) {
                this.log(`[${agent.name}] Idle but hungry. Seeking food.`);
                return { isDirty: true, nextState: 'fsm_eating' }; 
            }
            
            // Critical Need 3: Sleep
            if ((agent.energy ?? 0) < 20) {
                this.log(`[${agent.name}] Idle but exhausted. Seeking sleep.`);
                return { isDirty: true, nextState: 'fsm_sleeping' }; 
            }
        }

        return { isDirty, walOp: null };
    }
}