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
        
        // BT Needs Evaluation
        CRITICAL_HUNGER: 85,
        CRITICAL_ENERGY_SCORE: 90,
        ACTION_THRESHOLD: 50,
        
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
    },

    // --- 10. Lifecycle & Generations ---
    LIFECYCLE: {
        PREGNANCY_BASE_CHANCE: 0.003,
        PREGNANCY_AGE_PENALTY_START: 35,
        PREGNANCY_MAX_AGE: 50,
        PREGNANCY_DURATION_DAYS: 270,
        MAX_CHILDREN_PENALTY: 3,
        MARRIAGE_AFFINITY_THRESHOLD: 80,
        MARRIAGE_MIN_DATING_DAYS: 90,
        DIVORCE_AFFINITY_THRESHOLD: 20,
        DIVORCE_STRESS_THRESHOLD: 70,
        DIVORCE_BASE_CHANCE: 0.001,
        EMIGRATION_BASE_CHANCE: 0.005,
        EMIGRATION_RENT_FAILURE_THRESHOLD: 3,
        EMIGRATION_MOOD_THRESHOLD: -80,
        IMMIGRATION_RATE: 2,
        ELDER_ENERGY_PENALTY: 0.15,
        ELDER_ILLNESS_MULTIPLIER: 2.0,
        PENSION_DAILY_INCOME: 40,
        CHILD_SOCIAL_DECAY_MULT: 1.5,
        CHILD_BOREDOM_DECAY_MULT: 1.5,
        TEEN_PART_TIME_SALARY_MULT: 0.4,

        AGE_DISTRIBUTION: [
            { min: 0, max: 12, weight: 0.15, label: 'child' },
            { min: 13, max: 17, weight: 0.08, label: 'teen' },
            { min: 18, max: 30, weight: 0.30, label: 'young_adult' },
            { min: 31, max: 50, weight: 0.28, label: 'mid_career' },
            { min: 51, max: 64, weight: 0.12, label: 'late_career' },
            { min: 65, max: 85, weight: 0.07, label: 'elder' },
        ],

        MORTALITY_RATES: [
            { minAge: 0, maxAge: 49, dailyChance: 0.000001 },
            { minAge: 50, maxAge: 64, dailyChance: 0.00001 },
            { minAge: 65, maxAge: 74, dailyChance: 0.0001 },
            { minAge: 75, maxAge: 84, dailyChance: 0.0005 },
            { minAge: 85, maxAge: 94, dailyChance: 0.002 },
            { minAge: 95, maxAge: 150, dailyChance: 0.01 },
        ],

        LIFE_STAGES: {
            CHILD_MAX: 12,
            TEEN_MAX: 17,
            ADULT_MAX: 64,
        },
    },

    // --- 11. Politics & Elections ---
    POLITICS: {
        TERM_LENGTH_DAYS: 90,
        CAMPAIGN_SEASON_DAYS: 20,
        PRIMARY_DAYS_BEFORE_GENERAL: 5,
        CANDIDATE_MIN_AGE: 25,
        ELECTION_CHECK_INTERVAL_TICKS: 96,
        MAX_CANDIDATES_PER_RACE: 4,
        MIN_CANDIDATES_PER_RACE: 2,

        OPINION_DRIFT_RATE: 0.5,
        OPINION_DRIFT_RENT_FAILURE: 10,
        OPINION_DRIFT_MUGGED: 15,
        OPINION_DRIFT_JOB_LOSS: 8,

        INCUMBENCY_BONUS: 15,
        PARTY_LOYALTY_WEIGHT: 0.3,
        ISSUE_ALIGNMENT_WEIGHT: 0.5,
        CHARISMA_WEIGHT: 0.2,

        CAMPAIGN_EVENT_CHANCE: 0.15,
        SCANDAL_CHANCE: 0.05,
        ENDORSEMENT_CHANCE: 0.10,
        APPROVAL_DECAY_RATE: 0.1,
        APPROVAL_BOOST_ON_WIN: 10,

        CANDIDATE_WEIGHT_HIGH_SOCIAL: 2.0,
        CANDIDATE_WEIGHT_RELEVANT_JOB: 3.0,
        CANDIDATE_ELIGIBLE_JOBS: [
            'Lawyer (Corporate)', 'Teacher', 'Social Worker',
            'Journalist/Writer', 'Marketing Manager', 'Accountant',
            'Management Consultant', 'Police Officer',
        ],

        ENGAGEMENT_BASE: 40,
        ENGAGEMENT_POLITICS_INTEREST_BONUS: 30,
        ENGAGEMENT_EDUCATION_COLLEGE_BONUS: 10,
        ENGAGEMENT_EDUCATION_GRADUATE_BONUS: 15,
        ENGAGEMENT_AGE_ELDER_BONUS: 10,

        VOTER_TURNOUT_BASE: 0.35,
        VOTER_TURNOUT_ENGAGEMENT_SCALE: 0.006,
    },
};