import { BaseState } from './BaseState.js';
import { GAME_BALANCE } from '../../data/balance.js';
import worldGraph from '../../data/worldGraph.js';
import eventBus from '../../engine/eventBus.js';

const EATING_CONFIG = {
    BASE_REGEN: 8.0, 
    SOCIAL_BONUS: 0.5,
    STRESS_EATING_THRESHOLD: 60,
    RAVENOUS_THRESHOLD: 80, 
    STUFFED_BUFFER: -5,
    
    // New configurations for economy and digestion
    COST_RESTAURANT: 25,
    COST_DINER: 12,
    COST_SNACK: 5,
    COST_DELIVERY: 20,     // Cost to order food if fridge is empty
    FOOD_COMA_CHANCE: 0.25 // 25% chance to get sluggish if overeating
};

export class EatingState extends BaseState {
    // [REF] Stateless Architecture: Removed constructor

    // [REF] Added agent param
    enter(agent) {
        super.enter(agent);
        this._updateActivityFromState(agent);
        
        // [REF] Move stateful properties to agent.stateContext
        agent.stateContext.initialHunger = agent.hunger || 0;
        
        // Initialize multipliers (Default to standard meal)
        agent.stateContext.mealQualityMultiplier = 1.0; 
        agent.stateContext.mealMoodBonus = 0;
        
        // Determine what we are eating based on Location & Inventory
        this._handleResources(agent);
        
        if (agent.stateContext.initialHunger > EATING_CONFIG.RAVENOUS_THRESHOLD) {
            this.log(`[${agent.name}] Started eating rapidly.`);
        } else {
            this.log(`[${agent.name}] Started eating.`);
        }
    }

    // [REF] Added agent param
    _handleResources(agent) {
        // Ensure inventory structure exists
        if (!agent.inventory) agent.inventory = {};

        const loc = worldGraph.nodes[agent.locationId];
        const isHome = agent.locationId === agent.homeLocationId;
        const isWork = agent.locationId === agent.workLocationId; 

        // === CASE 1: EATING AT HOME ===
        if (isHome) {
            // Priority 1: Cook Groceries
            if ((agent.inventory.groceries || 0) > 0) {
                agent.inventory.groceries--;
                agent.stateContext.mealQualityMultiplier = 1.2; // Home cooked is healthy/filling
                agent.stateContext.mealMoodBonus = 1.5;
                this.log(`[${agent.name}] Cooked a meal using groceries. (Left: ${agent.inventory.groceries})`);
                return;
            } 
            
            // Priority 2: Order Delivery (if rich enough)
            if ((agent.money || 0) >= EATING_CONFIG.COST_DELIVERY) {
                agent.money -= EATING_CONFIG.COST_DELIVERY;
                agent.stateContext.mealQualityMultiplier = 1.0;
                agent.stateContext.mealMoodBonus = 2.0; // Pizza makes people happy
                this.log(`[${agent.name}] Fridge empty. Ordered delivery (-$${EATING_CONFIG.COST_DELIVERY}).`);
                return;
            }

            // Priority 3: Scraps
            agent.stateContext.mealQualityMultiplier = 0.6;
            agent.stateContext.mealMoodBonus = -1.0;
            this.log(`[${agent.name}] No food, no money. Scrounging for pantry scraps.`);
            return;
        }

        // === CASE 2: EATING OUT / AT WORK ===
        let cost = 0;
        
        if (loc) {
            if (loc.type === 'restaurant') {
                cost = EATING_CONFIG.COST_RESTAURANT;
                agent.stateContext.mealQualityMultiplier = 1.4;
                agent.stateContext.mealMoodBonus = 3.0;
            } else if (['diner', 'cafe'].includes(loc.type)) {
                cost = EATING_CONFIG.COST_DINER;
                agent.stateContext.mealQualityMultiplier = 1.1;
                agent.stateContext.mealMoodBonus = 1.5;
            } else if (['vending_machine', 'convenience_store'].includes(loc.type)) {
                cost = EATING_CONFIG.COST_SNACK;
                agent.stateContext.mealQualityMultiplier = 0.8; // Junk food is less filling
                agent.stateContext.mealMoodBonus = 0.5;
            } else if (isWork) {
                // Work Cafeteria / Packed Lunch
                cost = EATING_CONFIG.COST_SNACK;
                agent.stateContext.mealQualityMultiplier = 1.0;
                agent.stateContext.mealMoodBonus = 0.5; // Taking a break is nice
            }
        }

        // Apply Transaction
        if (cost > 0) {
            if (worldGraph.consumeStock(loc.key)) { // Consume stock only if successful
                if ((agent.money || 0) >= cost) {
                    agent.money -= cost;
                    // Success: Multipliers and Bonuses set above apply
                } else {
                    // Failed Transaction
                    agent.stateContext.mealQualityMultiplier = 0.5; // Hunger goes down slowly
                    agent.stateContext.mealMoodBonus = -2.0; // Humiliating/Frustrating
                    this.log(`[${agent.name}] Cannot afford meal at ${loc?.type || 'location'}.`);
                }
            } else {
                // Out of Stock
                agent.stateContext.mealQualityMultiplier = 0.5;
                agent.stateContext.mealMoodBonus = -1.0;
                this.log(`[${agent.name}] Location ${loc.name} is out of stock.`);
            }
        }
    }

    // [REF] Added agent param
    tick(agent, hour, localEnv, worldState) {
        // Pause Stress calculation so they don't get stressed about time while eating
        super.tick(agent, hour, localEnv, worldState, { 
            skipHunger: true,
            skipStressCalculation: true 
        });

        let isDirty = (worldState.currentTick % 5 === 0);

        // Apply the pre-calculated quality multipliers from enter()
        let regenRate = (GAME_BALANCE.REGEN.EAT || EATING_CONFIG.BASE_REGEN) * agent.stateContext.mealQualityMultiplier;
        let moodBoost = (GAME_BALANCE.REGEN.MOOD_BOOST_EATING || 1.0) + agent.stateContext.mealMoodBonus;

        // --- 1. Dynamic Speed Modifiers ---
        
        if (agent.stateContext.initialHunger > EATING_CONFIG.RAVENOUS_THRESHOLD) {
            regenRate *= 1.5; 
        }

        if ((agent.stress ?? 0) > EATING_CONFIG.STRESS_EATING_THRESHOLD) {
            regenRate *= 1.2; 
            agent.stress = Math.max(0, (agent.stress ?? 0) - 1.5); 
        }

        // --- 2. Social Modifiers ---
        const nearbyPeople = agent.perceivedAgents ? agent.perceivedAgents.length : 0;
        if (nearbyPeople > 0) {
            // REALISM TWEAK: Eating while talking is slower, but better for mood
            regenRate *= 0.9; 
            moodBoost += EATING_CONFIG.SOCIAL_BONUS; 
            agent.social = Math.min(100, (agent.social ?? 0) + 1.0);
        }

        // --- 3. Apply Stats ---
        agent.hunger = (agent.hunger ?? 0) - regenRate;
        agent.mood = Math.min(100, (agent.mood ?? 0) + moodBoost);
        
        // --- 4. Flavor Events ---
        if (Math.random() < 0.01) {
            this._handleFlavorEvents(agent, worldState.currentTick);
        }
        
        // --- 5. Completion Logic ---
        if (agent.hunger <= EATING_CONFIG.STUFFED_BUFFER) {
            // [REF] _finishEating now returns the transition object
            return this._finishEating(agent);
        }

        return { isDirty, walOp: null };
    }

    // [REF] Added agent param
    _handleFlavorEvents(agent, currentTick) {
        // Removed hardcoded event strings
        
        // Randomly adjust mood
        const moodAdjustment = Math.floor(Math.random() * 21) - 10; // -10 to +10
        agent.mood = Math.max(0, Math.min(100, (agent.mood ?? 0) + moodAdjustment));
        
        if (Math.abs(moodAdjustment) >= 5) {
            // Generic memory event
            eventBus.emit('db:writeMemory', 'low', agent.id, currentTick, `Experienced a significant moment while eating (Mood change: ${moodAdjustment}).`);
            if (agent.lod === 1) this.log(`[${agent.name}] Felt a sudden mood shift while eating.`);
        }
    }

    // [REF] Added agent param
    _finishEating(agent) {
        agent.hunger = 0; 

        this.log(`[${agent.name}] Finished eating. I'm full.`);
        
        if (!agent.status_effects) agent.status_effects = [];
        
        // CHECK FOR FOOD COMA (Debuff)
        const gotFoodComa = Math.random() < EATING_CONFIG.FOOD_COMA_CHANCE;

        if (gotFoodComa) {
            agent.status_effects.push({
                type: 'LETHARGIC',
                duration: 60, // ~30-60 mins
                magnitude: 0.5
            });
            if (agent.lod === 1) this.log(`[${agent.name}] Feeling sluggish after meal.`);
        } else {
            // Apply WELL_FED buff (Benefits)
            const buffMagnitude = agent.stateContext.mealQualityMultiplier >= 1.0 ? 0.5 : 0.2;
            
            agent.status_effects.push({
                type: 'WELL_FED',
                duration: 180, 
                magnitude: buffMagnitude 
            });
        }

        const currentIntention = agent.intentionStack?.[agent.intentionStack.length - 1];
        if (currentIntention && currentIntention.goal === 'fsm_eating') {
            agent.intentionStack.pop();
        }
        
        return { isDirty: true, nextState: 'fsm_idle' };
    }
}