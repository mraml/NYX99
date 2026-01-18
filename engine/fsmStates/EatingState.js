import { BaseState } from './BaseState.js';
import { Selector, Sequence, Condition, Action, Status } from '../BehaviorTreeCore.js';
import { GAME_BALANCE } from '../../data/balance.js';
import worldGraph from '../../data/worldGraph.js';
import eventBus from '../../engine/eventBus.js';

const EATING_CONFIG = {
    BASE_REGEN: 15.0, 
    SOCIAL_BONUS: 0.5,
    STRESS_EATING_THRESHOLD: 60,
    RAVENOUS_THRESHOLD: 80, 
    STUFFED_BUFFER: -40, // Increased buffer to -40 for deeper satiety
    COST_RESTAURANT: 25,
    COST_DINER: 12,
    COST_SNACK: 5,
    COST_DELIVERY: 20,
    FOOD_COMA_CHANCE: 0.25,
    MEAL_COOLDOWN_TICKS: 16 // ~4 hours (assuming 15m ticks)
};

// === 1. LEAF NODES ===

const Actions = {
    // Determines WHAT we are eating. Runs if stateContext.mealConfig is missing.
    PrepareMeal: (agent, context) => {
        if (agent.stateContext.mealConfig) return Status.SUCCESS;

        const config = {
            qualityMultiplier: 1.0,
            moodBonus: 0,
            source: 'unknown'
        };

        const loc = worldGraph.nodes[agent.locationId];
        const isHome = agent.locationId === agent.homeLocationId;
        const isWork = agent.locationId === agent.workLocationId; 

        // Ensure inventory structure
        if (!agent.inventory) agent.inventory = [];

        // Logic Block: Determine source
        if (isHome) {
            // Check for groceries in inventory (assuming array structure)
            const groceryIndex = agent.inventory.findIndex(i => i.type === 'food');
            
            if (groceryIndex !== -1) {
                // CONSUME GROCERIES
                const item = agent.inventory[groceryIndex];
                item.usesLeft--;
                if (item.usesLeft <= 0) agent.inventory.splice(groceryIndex, 1);
                
                config.qualityMultiplier = 1.5; // Boosted home cooking effectiveness
                config.moodBonus = 1.5;
                config.source = 'home_cooked';
            } 
            else if ((agent.money || 0) >= EATING_CONFIG.COST_DELIVERY) {
                // ORDER DELIVERY
                agent.money -= EATING_CONFIG.COST_DELIVERY;
                config.qualityMultiplier = 1.2;
                config.moodBonus = 2.0;
                config.source = 'delivery';
            } else {
                // SCRAPS
                config.qualityMultiplier = 0.8; // Scraps are less effective but not useless
                config.moodBonus = -1.0;
                config.source = 'scraps';
            }
        } else {
            // EATING OUT
            let cost = 0;
            if (loc?.type === 'restaurant') {
                cost = EATING_CONFIG.COST_RESTAURANT;
                config.qualityMultiplier = 2.0; // Restaurants are very filling
                config.moodBonus = 3.0;
            } else if (['diner', 'cafe'].includes(loc?.type)) {
                cost = EATING_CONFIG.COST_DINER;
                config.qualityMultiplier = 1.5;
                config.moodBonus = 1.5;
            } else if (['vending_machine', 'convenience_store'].includes(loc?.type)) {
                cost = EATING_CONFIG.COST_SNACK;
                config.qualityMultiplier = 1.0; 
                config.moodBonus = 0.5;
            } else if (isWork) {
                cost = EATING_CONFIG.COST_SNACK;
                config.qualityMultiplier = 1.2;
                config.source = 'work_lunch';
            }

            // Transaction
            if (cost > 0) {
                if (worldGraph.consumeStock(loc.key) && (agent.money || 0) >= cost) {
                    agent.money -= cost;
                    config.source = loc.type;
                } else {
                    // Failed to buy
                    config.qualityMultiplier = 0.5;
                    config.moodBonus = -2.0;
                    config.source = 'failed_transaction';
                }
            }
        }

        agent.stateContext.mealConfig = config;
        
        // Log setup
        if (agent.lod === 1) {
            console.log(`[${agent.name}] Meal prepared: ${config.source} (Quality: ${config.qualityMultiplier})`);
        }
        
        return Status.SUCCESS;
    },

    ConsumeFood: (agent, context) => {
        const config = agent.stateContext.mealConfig;
        
        let regenRate = (GAME_BALANCE.REGEN.EAT || EATING_CONFIG.BASE_REGEN) * config.qualityMultiplier;
        let moodBoost = (GAME_BALANCE.REGEN.MOOD_BOOST_EATING || 1.0) + config.moodBonus;

        // Dynamic Modifiers
        if (agent.stateContext.initialHunger > EATING_CONFIG.RAVENOUS_THRESHOLD) regenRate *= 1.5;
        
        // Stress Eating
        if ((agent.stress ?? 0) > EATING_CONFIG.STRESS_EATING_THRESHOLD) {
            regenRate *= 1.2;
            agent.stress = Math.max(0, (agent.stress ?? 0) - 1.5);
        }

        // Apply
        agent.hunger = (agent.hunger ?? 0) - regenRate;
        agent.mood = Math.min(100, (agent.mood ?? 0) + moodBoost);

        // Flavor
        if (Math.random() < 0.01) {
            agent.mood += (Math.random() * 10) - 5;
        }

        return Status.SUCCESS;
    },

    FinishMeal: (agent, context) => {
        // Ensure we leave the state with negative hunger (fullness buffer)
        // If we just hit 0, we might tick up to 0.1 next tick and start eating again.
        // The condition IsFull checks for STUFFED_BUFFER (-40), so we are good.
        
        if (!agent.status_effects) agent.status_effects = [];
        
        // Record last meal tick to prevent immediate re-eating in IdleState
        agent.lastMealTick = context.worldState.currentTick;

        // Food Coma Check
        const config = agent.stateContext.mealConfig;
        if (Math.random() < EATING_CONFIG.FOOD_COMA_CHANCE) {
            agent.status_effects.push({ type: 'LETHARGIC', duration: 60, magnitude: 0.5 });
        } else {
            // WELL_FED: Stronger effect (0.1 decay multiplier) and longer duration (48 ticks / ~12 hours)
            // to essentially pause hunger for the day.
            const mag = config.qualityMultiplier >= 1.2 ? 0.1 : 0.4;
            agent.status_effects.push({ type: 'WELL_FED', duration: 48, magnitude: mag });
        }

        // Add explicit satiety status if not already present logic handled by WELL_FED above
        // We ensure we don't have duplicates
        const existingWellFedIndex = agent.status_effects.findIndex(e => e.type === 'WELL_FED');
        if (existingWellFedIndex !== -1 && agent.status_effects[existingWellFedIndex].duration < 48) {
             // Upgrade existing effect if it's weaker/shorter
             agent.status_effects[existingWellFedIndex].duration = 48;
             agent.status_effects[existingWellFedIndex].magnitude = (config.qualityMultiplier >= 1.2 ? 0.1 : 0.4);
        }

        if (agent.intentionStack) agent.intentionStack.pop();
        return { isDirty: true, nextState: 'fsm_idle' };
    }
};

const Conditions = {
    // We stay in this state until we are sufficiently "stuffed" (negative hunger)
    IsFull: (agent) => (agent.hunger <= EATING_CONFIG.STUFFED_BUFFER),
    
    // New check: Is it actually appropriate to eat right now?
    // If we just entered and aren't hungry enough or recently ate, we might bail early.
    // Note: This is mostly a safeguard for re-entry logic.
    ShouldEat: (agent, { hour, worldState }) => {
        // If starving, always eat
        if ((agent.hunger ?? 0) > 80) return true;
        
        // If we already started eating (have a config), continue
        if (agent.stateContext.mealConfig) return true;

        // Check cooldown
        const lastMeal = agent.lastMealTick || -999;
        const ticksSinceMeal = worldState.currentTick - lastMeal;
        
        if (ticksSinceMeal < EATING_CONFIG.MEAL_COOLDOWN_TICKS) {
            // Too soon to eat again unless starving
            return false;
        }
        
        return true;
    }
};

// === 2. BEHAVIOR TREE ===

const EatingTree = new Sequence([
    // Step 0: Pre-check (Bail if we shouldn't be here)
    new Selector([
        new Condition(Conditions.ShouldEat),
        new Action((agent) => {
            // Bail out action
            if (agent.intentionStack) agent.intentionStack.pop();
            return { isDirty: true, nextState: 'fsm_idle' };
        })
    ]),

    // Step 1: Ensure we have a meal configuration (Resilient to loads)
    new Action(Actions.PrepareMeal),
    
    // Step 2: Check Completion
    new Selector([
        new Sequence([
            new Condition(Conditions.IsFull),
            new Action(Actions.FinishMeal)
        ]),
        // Step 3: Eat
        new Action(Actions.ConsumeFood)
    ])
]);

// === 3. STATE CLASS ===

export class EatingState extends BaseState {
    enter(agent) {
        super.enter(agent);
        this._updateActivityFromState(agent);
        agent.stateContext.initialHunger = agent.hunger || 0;
        agent.stateContext.mealConfig = null; // Will be set by Tree
    }

    tick(agent, hour, localEnv, worldState) {
        // Critical: skipHunger is TRUE to prevent passive hunger gain while eating
        super.tick(agent, hour, localEnv, worldState, { skipHunger: true, skipStressCalculation: true });

        const context = { hour, localEnv, worldState, transition: null };
        const status = EatingTree.execute(agent, context);

        if (context.transition) return context.transition;
        
        return { isDirty: (worldState.currentTick % 5 === 0), walOp: null };
    }
}