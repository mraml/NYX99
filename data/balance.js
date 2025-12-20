/**
 * data/balance.js
 * The Single Source of Truth for Game Design & Tuning.
 * * ARCHITECTURE NOTE:
 * Some specific mechanic probabilities (like "chance of biting tongue") are 
 * encapsulated in their respective State files (e.g., EatingState.js).
 * This file governs the GLOBAL Economy, Metabolism, and macro-behavior.
 */

export const GAME_BALANCE = {
    // --- 1. Needs Regeneration (Per Tick of Activity) ---
    // NOTE: These are "Base" rates. States apply multipliers (quality, comfort, etc.)
    REGEN: {
        EAT: 10.0,          // Reduced from 20 to prevent instant fullness
        SLEEP: 8.0,         // Reduced from 25 to encourage full night sleep
        SOCIALIZE: 15.0,    // Social battery recharges moderately fast
        STRESS_REDUCTION: 0.5,
        BOREDOM_REDUCTION: 10.0,
        
        // Mood Boosts (Flat amount per tick)
        MOOD_BOOST_EATING: 2.0,      
        MOOD_BOOST_SOCIAL: 2.5,      
        MOOD_BOOST_RECREATION: 3.0,  
    },

    // --- 2. Passive Decay (Per Tick of Existence) ---
    // Used by BaseState.tick() when mode.decay is true
    DECAY: {
        ENERGY: 0.25, 
        HUNGER: 0.40, // Increased slightly to force eating ~3 times a day
        SOCIAL: 0.20, 
        BOREDOM: 0.50, 
    },

    // --- 3. Circadian Rhythm Multipliers ---
    // Used by BaseState to modulate decay rates based on time of day
    CIRCADIAN: {
        HUNGER_MEAL_MULTIPLIER: 1.5,    
        HUNGER_SLEEP_MULTIPLIER: 0.1,   // Almost zero hunger decay while sleeping
        ENERGY_NIGHT_MULTIPLIER: 1.5,   // Get tired faster at night
        ENERGY_MORNING_MULTIPLIER: 0.8, // Fresh in the morning
    },

    // --- 4. Emotional & Stress Rules ---
    // Used by BaseState.tick() when mode.stress is true
    EMOTIONAL: {
        STRESS_PENALTY_LOW_ENERGY: 1.5, 
        STRESS_PENALTY_HIGH_HUNGER: 2.0, 
        STRESS_PENALTY_HIGH_SOCIAL: 1.0, 
        STRESS_PENALTY_NOISE: 1.2,  
    },
    
    // --- 5. Social Simulation (Crowds & Personality) ---
    // New section to support BaseState social anxiety logic
    SOCIAL_SIM: {
        CROWD_SIZE_THRESHOLD: 3,       // How many people constitute a "Crowd"
        INTROVERT_STRESS_PENALTY: 0.05, // Per tick penalty for introverts in crowds
        EXTROVERT_CROWD_BONUS: 0.1,    // Social battery gain for extroverts in crowds
        ISOLATION_PENALTY: 0.1         // Extra decay for extroverts alone
    },

    // --- 6. AI Utility Scoring Weights ---
    // Used by actionScorer.js to weigh decisions
    SCORES: {
        IDLE: 0.1,
        WANDER: 1.0,
        SLEEP_BASE: 80,
        EAT_BASE: 75,
        WORK_BASE: 150,
        SOCIAL_BASE: 120,
        NOVELTY_BASE: 130,
        MAINTENANCE_BASE: 50,
        HEALTHCARE_BASE: 200, // New: High priority for sickness
        
        // Contextual Modifiers
        URGENT_MULTIPLIER: 2.0, // Used when a need is > 80%
        CRITICAL_MULTIPLIER: 10.0, // Used when a need is > 95%
        
        // Personality Bonuses
        ASPIRATION_BONUS: 300,
        RELATIONSHIP_PRIORITY_BONUS: 350,
    },

    // --- 7. Thresholds & Triggers ---
    THRESHOLDS: {
        // Needs
        HUNGER_TO_EAT: 70,
        ENERGY_TO_SLEEP: 80,
        SOCIAL_TO_SOCIALIZE: 60,
        
        // Economy
        MONEY_TO_WORK: 500, // If below this, work is prioritized
        
        // Desperation Levels (Used by Scorer)
        STARVATION_EMERGENCY: 95, 
        EXHAUSTION_EMERGENCY: 5,  

        // Mental Health
        SPIRAL_THRESHOLD: 60,     // BaseState: Stress > 60 starts affecting Mood
        BURNOUT_THRESHOLD: 90,    // WorkingState: Stress > 90 causes quitting
        
        // Personality Modifiers
        CONSCIENTIOUSNESS_WORK_MOD: 300, 
    },
    
    // --- 8. Economy & Costs ---
    COSTS: {
        HOUSING_DOWNPAYMENT: 3500, 
        MAINTENANCE: 25,
        GROCERIES: 15,
        
        // Travel
        TAXI_BASE: 5.00,
        TAXI_PER_MILE: 2.50,
        SUBWAY_FARE: 2.75,
        
        // Shopping Behaviors (Used by ShoppingState)
        IMPULSE_BUY_MULTIPLIER: 1.5, 
        BARGAIN_HUNT_MULTIPLIER: 0.8, 
    },

    // --- 9. World Simulation Rules ---
    WORLD: {
        WEATHER_CHANGE_CHANCE: 0.05,
        BASE_BUILDING_DEGRADATION: 0.01,
    }
};