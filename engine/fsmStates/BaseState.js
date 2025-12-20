import eventBus from '../eventBus.js';
import worldGraph from '../../data/worldGraph.js';
import { updateCurrentActivity } from '../agent/agentActivity.js';
import { GAME_BALANCE } from '../../data/balance.js'; 

export class BaseState {
    // [REF] Stateless Architecture: Removed constructor(fsm).
    // State instances are now singletons. No instance-specific data allowed here.
    constructor() {
        this.name = 'BaseState';
        // Note: subclasses can define this.displayName in their constructor if it's constant
    }

    // [REF] Added agent parameter
    enter(agent, params = {}) {
        // Initialize the context for this specific agent's session in this state
        agent.stateContext = agent.stateContext || {};
    }
    
    // [REF] Added agent parameter
    exit(agent) {
        // Cleanup handled by FSM, but states can do custom cleanup here
    }

    // [REF] Added agent parameter as first argument
    tick(agent, hour, localEnv, worldState, overrides = {}) {
        // --- 1. CIRCADIAN RHYTHMS ---
        let hungerMult = 1.0;
        let energyMult = 1.0;

        const isMealTime = (hour >= 7 && hour < 9) || (hour >= 12 && hour < 14) || (hour >= 18 && hour < 20);
        
        if (isMealTime) {
            hungerMult = GAME_BALANCE.CIRCADIAN.HUNGER_MEAL_MULTIPLIER; 
        } else if (hour >= 1 && hour < 6) {
            hungerMult = GAME_BALANCE.CIRCADIAN.HUNGER_SLEEP_MULTIPLIER; 
        }

        if (hour >= 23 || hour < 5) {
            energyMult = GAME_BALANCE.CIRCADIAN.ENERGY_NIGHT_MULTIPLIER; 
        } else if (hour >= 9 && hour < 12) {
            energyMult = GAME_BALANCE.CIRCADIAN.ENERGY_MORNING_MULTIPLIER; 
        }

        // --- Weather Impact (Thermoregulation) ---
        const globalTemp = worldState.environment?.globalTemp ?? 20;
        if (globalTemp > 30 || globalTemp < 5) {
            energyMult *= 1.2; 
        }

        // --- Sickness Impact ---
        if (agent.status_effects && agent.status_effects.some(e => e.type === 'SICK')) {
            energyMult *= 1.5;
        }

        hungerMult = Math.min(hungerMult, 3.0);
        energyMult = Math.min(energyMult, 3.0);

        // --- 2. PASSIVE DECAY ---
        
        if (!overrides.skipEnergy) {
             agent.energy = Math.max(0, (agent.energy ?? 100) - (GAME_BALANCE.DECAY.ENERGY * energyMult));
        }

        if (!overrides.skipHunger) {
             agent.hunger = Math.min(100, (agent.hunger ?? 0) + (GAME_BALANCE.DECAY.HUNGER * hungerMult));
        }

        if (!overrides.skipSocial) {
             // --- Personality-Based Social Decay ---
             const crowdCount = agent.perceivedAgents?.length || 0;
             const extroversion = agent.persona?.extroversion ?? 0.5;
             
             let socialDecayMult = 1.0;
             if (crowdCount > 0) {
                 socialDecayMult = 0.5; // Decay slower when around people
             } else if (extroversion > 0.7) {
                 socialDecayMult = 1.5; // Extroverts get lonely faster
             } else if (extroversion < 0.3) {
                 socialDecayMult = 0.8; // Introverts are fine being alone
             }

             agent.social = Math.min(100, (agent.social ?? 0) + (GAME_BALANCE.DECAY.SOCIAL * socialDecayMult));
        }

        if (!overrides.skipBoredom) {
            const intBonus = (agent.persona?.openness ?? 0.5) > 0.7 ? 1.2 : 1.0;
            agent.boredom = Math.min(100, (agent.boredom ?? 0) + (GAME_BALANCE.DECAY.BOREDOM * intBonus));
        }

        // --- 3. EMOTIONAL CONSEQUENCES ---
        if (!overrides.skipStressCalculation) {
            let stressPenalty = 0;
            
            // Biological Stressors
            if ((agent.energy ?? 100) < 10) stressPenalty += GAME_BALANCE.EMOTIONAL.STRESS_PENALTY_LOW_ENERGY; 
            if ((agent.hunger ?? 0) > 90) stressPenalty += GAME_BALANCE.EMOTIONAL.STRESS_PENALTY_HIGH_HUNGER; 
            if ((agent.social ?? 0) > 90) stressPenalty += GAME_BALANCE.EMOTIONAL.STRESS_PENALTY_HIGH_SOCIAL; 
            
            // Environmental Stressors (Noise)
            if ((localEnv.noise ?? 0) > 0.8 && agent.persona.stressProneness > 0.5) {
                stressPenalty += GAME_BALANCE.EMOTIONAL.STRESS_PENALTY_NOISE;
            }

            // --- Social Anxiety (Crowds) ---
            const crowdCount = agent.perceivedAgents?.length || 0;
            if (crowdCount > 3 && (agent.persona?.extroversion ?? 0.5) < 0.3) {
                stressPenalty += 0.05; 
            }

            // --- Financial Anxiety ---
            if ((agent.money ?? 0) < (agent.rent_cost ?? 0)) {
                const financialStress = agent.persona.stressProneness > 0.7 ? 0.05 : 0.02;
                stressPenalty += financialStress;
            }

            agent.stress = Math.min(100, (agent.stress ?? 0) + stressPenalty);
            
            // Mood Spiral
            if ((agent.stress ?? 0) > 60) {
                const spiralFactor = agent.persona.stressProneness > 0.6 ? 0.8 : 0.5;
                agent.mood = Math.max(-100, (agent.mood ?? 0) - (agent.stress / 100) * spiralFactor);
            }
        }
        
        return { isDirty: true, walOp: null };
    }

    // [REF] Added agent parameter
    _updateActivityFromState(agent) {
        // Check local instance property 'displayName' (must be stateless constant now)
        if (this.displayName) {
            agent.currentActivity = this.displayName;
        } else {
            const hour = agent.matrix?.worldTime?.getHours() || 12;
            updateCurrentActivity(agent, agent.state, hour);
        }
    }

    // [REF] Added agent parameter
    _getHomeNode(agent) {
        if (!agent.homeLocationId) {
            return null;
        }
        return worldGraph.nodes[agent.homeLocationId] || null;
    }

    log(message) {
        eventBus.queue('log:agent', 'low', message);
    }
}