import crypto from 'crypto';
import { STARTING_MONEY } from '../data/config.js';
import { FiniteStateMachine } from './fsm.js';
import { dataLoader, ITEM_CATALOG } from '../data/dataLoader.js';
import worldGraph from '../data/worldGraph.js';
import { 
  getConsumableFoodItem, 
  consumeItem, 
  hasHobbyItem,
  createInitialInventory 
} from './agent/agentInventory.js'; 
import { 
  rehydrateActivity as activityRehydrate, 
  updateCurrentActivity as activityUpdate
} from './agent/agentActivity.js'; 
import { 
  generateRandomName, 
  generateRandomJob, 
  generateInterests, 
  generatePersona, 
  generateAspiration,
  calculateThresholds,
  coerceObject
} from './agentUtilities.js';

import {
  scoreAcquireHousing,
  scoreSleep,
  scoreEatAndShop,
  scoreWork
} from './agent/scoring/scorerNeeds.js';
import { PriorityQueue } from './structures/PriorityQueue.js'; 

import logger from '../logger.js';

// === CONFIGURATION ===
// Centralized tuning for the Agent core logic
const AGENT_CONFIG = {
    // Time Constants (1 Tick = 15 Minutes)
    // Explicitly documented to ensure duration math is consistent across the project
    TIME: {
        TICK_DURATION_MIN: 15,
        TICKS_PER_HOUR: 4,
        TICKS_PER_DAY: 96
    },

    // Standardized Status Effect Durations (in Ticks)
    // Calculated based on 15-minute ticks
    STATUS_DURATIONS: {
        WELL_FED: 20,    // ~5 Hours (vs old ~7.5 days)
        WELL_RESTED: 32, // ~8 Hours (vs old ~10 days)
        LETHARGIC: 12,   // ~3 Hours
        CAFFEINATED: 8,  // ~2 Hours
        GROGGY: 4        // ~1 Hour
    },

    // Limits & Buffers
    INTENTION_TIMEOUT_TICKS: 96 * 3, // 3 Days (Adjusted for 15m ticks: 96/day * 3)
    HISTORY_BUFFER_SIZE: 40,
    RELATIONSHIP_HISTORY_SIZE: 50,
    MAX_INTENTION_DEPTH: 5,
    RECENT_ACTIVITY_BUFFER: 5,
    
    // Base Metabolic Decay Rates (Per Tick)
    // NOTE: These are modified by getStatMultiplier() based on status effects
    DECAY: {
        HUNGER: 0.3, // Reduced from 0.5 to prevent bankruptcy spiral (12.5 -> 7.5 daily hunger)
        ENERGY: 0.3,
        BOREDOM: 0.2,
        SOCIAL: 0.2,
        // Stress Management
        STRESS_PASSIVE: 0.1,    // Natural relaxation when needs are met
        STRESS_RECREATION: 1.0, // Active stress venting
        STRESS_SOCIAL: 0.5      // Social bonding benefit (Extroverts)
    },
    
    // Default Relationship
    DEFAULT_REL_VALUES: { affinity: 0, score: 0, type: 'acquaintance', history: [] },

    // Safe Math Bounds
    MATH: {
        MIN_MULTIPLIER: 0.1,
        MAX_MULTIPLIER: 2.0 // Cap at 2.0x to prevent unrecoverable status spirals
    }
};

function safeParseComplex(value, fallback) {
    let result = coerceObject(value, fallback);
    if (typeof result === 'string') {
        try { return JSON.parse(result); } catch (e) { return fallback; }
    }
    return result ?? fallback;
}

class Agent {
  // Expose configuration for external scorers/generators to use
  static get CONFIG() { return AGENT_CONFIG; }

  constructor(data) {
    const { 
        id, name, hunger, energy, social, money, state, lod, nextTick, 
        locationId, isMetasim, persona, homeLocationId, workLocationId, 
        targetLocationId, job, interests, currentActivity, currentActivityName, travelTimer, 
        transitFrom, transitTo, inventory, status_effects, relationships, 
        skills, aspiration, partnerId, rentFailures, activityStartTick, 
        minActivityDuration, mood, stress, boredom, recentActivities, 
        beliefs, routines, contextualRoutines, intentionStack, intentionPlan, 
        history, circadianBias, habits, financial, burnout, socialState, rent_cost,
        // [REF] New stateContext property
        stateContext 
    } = data || {};
    
    const demographics = dataLoader.demographics;
    
    // Ensure ID is valid string
    if (typeof id === 'string' && id.length > 0 && id !== '[object Object]') {
        this.id = id;
    } else {
        this.id = crypto.randomUUID();
    }

    this.name = name || (demographics ? generateRandomName(demographics) : `Sim-${this.id.substring(0, 4)}`);
    
    // FIX [P6]: Organic Variance / Jitter
    this.hunger = hunger ?? Math.floor(Math.random() * 30); 
    this.social = social ?? Math.floor(Math.random() * 40); 
    this.boredom = boredom ?? Math.floor(Math.random() * 20); 
    this.stress = stress ?? Math.floor(Math.random() * 10); 
    this.energy = energy ?? (70 + Math.floor(Math.random() * 30)); 
    
    this._lastTickStress = this.stress;

    this.money = money ?? 5000; 
    this.mood = mood ?? 0; 
    
    this.burnout = burnout ?? 0;
    this.financial = safeParseComplex(financial, { weeklyExpenses: 400, debts: [] });
    this.habits = safeParseComplex(habits, {}); 

    this.state = state || 'fsm_idle';
    // [REF] Initialize stateContext. Critical for Flyweight FSM.
    this.stateContext = safeParseComplex(stateContext, {});

    this.lod = lod ?? 2;
    this.nextTick = nextTick ?? 0;
    
    // FIX [P1]: Persistence Logic Failure
    this.homeLocationId = homeLocationId;
    this.workLocationId = workLocationId;

    if (worldGraph?.findRandomLocationByType && worldGraph.nodes) {
        if (!this.homeLocationId) this.homeLocationId = worldGraph.findRandomLocationByType('home')?.key;
        if (!this.workLocationId) this.workLocationId = worldGraph.findRandomLocationByType('office')?.key;
    } 
    
    this.locationId = locationId || this.homeLocationId;
    this.targetLocationId = targetLocationId;
    this.rent_cost = rent_cost || 0;

    this.job = safeParseComplex(job, null);
    if (!this.job && demographics?.jobs) { this.job = generateRandomJob(demographics); } 
    if (this.job && !this.job.recentEvents) this.job.recentEvents = [];
    if (this.job && !this.job.satisfaction) this.job.satisfaction = 50;
    
    this.isMetasim = isMetasim || false;
    this.persona = safeParseComplex(persona, generatePersona());
    this.status_effects = safeParseComplex(status_effects, []);
    this.interests = safeParseComplex(interests, generateInterests(demographics)) ?? [];
    this.aspiration = safeParseComplex(aspiration, generateAspiration(this)); 
    this.skills = safeParseComplex(skills, {}) ?? {};
    this.relationships = safeParseComplex(relationships, {}) ?? {};
    
    this.inventory = safeParseComplex(inventory, createInitialInventory(this.job?.title, this.money));
    
    this.workStartHour = this.job?.hours?.[0] ?? 9;
    this.workEndHour = this.job?.hours?.[1] ?? 17;
    this.thresholds = calculateThresholds(this.persona); 

    this.initializeCircadianRhythm(circadianBias); 

    this.socializingTicks = 0;
    this.socializingSuccess = false;
    this.socialState = safeParseComplex(socialState, null); 
    
    this.intentionStack = safeParseComplex(intentionStack, []) ?? [];
    this.intentionPlan = safeParseComplex(intentionPlan, []) ?? [];
    this.partnerId = partnerId || null;
    this.rentFailures = rentFailures ?? 0;
    this.currentActivity = currentActivity || currentActivityName || 'Idling';
    this.currentActivityName = currentActivityName || 'idling';
    this.subLocation = null;
    this.activityStartTick = activityStartTick ?? 0;
    this.minActivityDuration = minActivityDuration ?? 0;
    this.travelTimer = travelTimer ?? 0;
    this.transitFrom = transitFrom || null;
    this.transitTo = transitTo || null;
    this.localEnv = { light: 0.5, temp: 20, noise: 0.2 };
    this.beliefs = safeParseComplex(beliefs, { weather: 'unknown', locationStatus: {}, perceivedAgents: [] });
    this.recentActivities = safeParseComplex(recentActivities, []) ?? [];
    this.routines = safeParseComplex(routines, []) ?? [];
    this.contextualRoutines = safeParseComplex(contextualRoutines, []) ?? [];
    this.history = safeParseComplex(history, { mood: [], energy: [], stress: [], money: [] });
    this.lastSocialPartner = null; 
    this.perceivedCrowding = 'empty'; 
    this.perceivedAgents = [];

    this.fsm = new FiniteStateMachine(this);
    this.clampStats();
    this.rehydrateActivity(); 
  }

  // --- NEW: Circadian Management ---
  initializeCircadianRhythm(existingBias = null) {
      if (existingBias) {
          this.circadianBias = existingBias;
          return;
      }
      const isNightOwl = this.persona?.traits?.includes('Night Owl');
      const isEarlyBird = this.persona?.traits?.includes('Early Bird');
      
      this.circadianBias = {
          peakHour: isNightOwl ? 22 : (isEarlyBird ? 8 : 14),
          troughHour: isNightOwl ? 6 : (isEarlyBird ? 22 : 4),
          biasStrength: 1.2
      };
  }

  // --- Core Update Loop ---
  update(tick, worldTime, worldState) {
    this._updateStatusEffects(); 
    this._decayStats(worldState); 
    
    // REPLENISHMENT LOGIC
    // FIX: Sleeping must reliably restore energy to 100
    if (this.state === 'fsm_sleeping') {
        // Recover energy while sleeping. 
        // ~4.5 per tick * 24 ticks = ~108 energy (Full recovery from 0)
        this.energy += 4.5; 
    }

    this._processSenses(worldState);
    this._updateStatusEffects();

    if (tick % 100 === 0) {
        this.updateHistory(); 
    }

    if (!this.inTransit) {
        if (this.fsm.isBusy()) {
            this.fsm.update(this);
        } else {
            this.decideNextAction({
                tick, 
                worldTime, 
                hour: worldTime.getHours(),
                isLateNight: (worldTime.getHours() >= 23 || worldTime.getHours() < 5),
                isMealTime: [8, 12, 18].includes(worldTime.getHours()),
                isWorkShift: this.isWorkShift(worldTime),
                isBusinessOpen: (worldTime.getHours() >= 9 && worldTime.getHours() < 21),
                thresholds: this.thresholds,
                persona: this.persona,
                currentLocation: worldGraph.nodes[this.locationId],
                currentLocationKey: this.locationId,
                PRIORITY_EMERGENCY: 1000,
                PRIORITY_HIGH: 500,
                PRIORITY_MEDIUM: 200,
                PRIORITY_LOW: 10
            });
        }
    } else {
        this._handleMovement();
    }
  }

  decideNextAction(context) {
    // DOOM LOOP FIX: Sleep Consistency
    if (this.state === 'fsm_sleeping') {
        const IS_STARVING = this.hunger > 95; 
        const HAS_SAFE_ENERGY = this.energy > 30; 
        const IS_FULLY_RESTED = this.energy >= 100;
        const IS_HUNGRY = this.hunger > 90;

        // If very low energy and not literally starving, keep sleeping
        if (!HAS_SAFE_ENERGY && !IS_STARVING) return;
        // If not fully rested and not hungry, keep sleeping
        if (!IS_FULLY_RESTED && !IS_HUNGRY && !IS_STARVING) return;
    }

    // DOOM LOOP FIX: Critical Hunger Override
    // If starving, bypass logic that might prioritize work/idle activities
    if (this.hunger > 90 && this.state !== 'fsm_eating') {
        // Rely on scoring to naturally pick up eating if we allow it to proceed,
        // but if we are here, we are not sleeping. 
        // We will fall through to PriorityQueue logic, but we need to ensure eating wins.
        // The transitionToState changes below ensure we can BREAK out of work.
    }

    const potentialActions = new PriorityQueue((a, b) => b.score - a.score);

    try {
        scoreAcquireHousing(this, context, potentialActions);
        scoreSleep(this, context, potentialActions);
        scoreEatAndShop(this, context, potentialActions);
        scoreWork(this, context, potentialActions);
        
        potentialActions.push({
            name: 'fsm_idle',
            score: 1, 
            priority: 0,
            target: this.locationId,
            reason: 'Bored',
            detailedReason: 'Nothing better to do'
        });

        if (potentialActions.isEmpty()) {
            potentialActions.push({
                 name: 'fsm_idle',
                 score: 1,
                 priority: 0,
                 target: this.locationId,
                 reason: 'Error Recovery',
                 detailedReason: 'Scorer failure'
            });
        }

        const bestAction = potentialActions.peek();

        if (bestAction) {
            this.transition(bestAction);
        } else {
            logger.error(`[SCORER] Agent ${this.id} has NO actions after scoring!`);
        }

    } catch (err) {
        logger.error(`CRITICAL SCORER CRASH for ${this.name}: ${err.message}`, { stack: err.stack });
        this.currentAction = { name: 'ERROR_RECOVERY', reason: 'Crash Recovery' };
    }
  }

  transition(action) {
      if (action.target && action.target !== this.locationId) {
          this.destinationId = action.target;
          this.fsm.transitionTo('fsm_in_transit', { 
              destination: action.target, 
              nextState: action.name, 
              reason: action.reason
          });
      } else {
          this.fsm.transitionTo(action.name, {
              target: action.target,
              reason: action.reason,
              expectedDuration: action.expectedDuration
          });
      }
      this.currentAction = action;
  }

  isWorkShift(worldTime) {
      const day = worldTime.getDay();
      const hour = worldTime.getHours();
      const days = this.job?.workDays || [1,2,3,4,5];
      if (!days.includes(day)) return false;
      return (hour >= this.workStartHour && hour < this.workEndHour);
  }

  _updateStatusEffects() {
      if (!this.status_effects || this.status_effects.length === 0) return;
      this.status_effects = this.status_effects.filter(effect => {
          effect.duration = (effect.duration || 0) - 1;
          return effect.duration > 0;
      });
  }

  getStatMultiplier(statName) {
      if (!this.status_effects || this.status_effects.length === 0) return 1.0;
      let multiplier = 1.0;
      for (const effect of this.status_effects) {
          if (effect.affectedStats && Array.isArray(effect.affectedStats) && effect.affectedStats.includes(statName)) {
              multiplier *= (effect.magnitude ?? 1.0);
          }
      }
      return Math.max(AGENT_CONFIG.MATH.MIN_MULTIPLIER, Math.min(AGENT_CONFIG.MATH.MAX_MULTIPLIER, multiplier));
  }

  _decayStats(worldState) {
      if (this.state !== 'fsm_eating') {
          let decayMult = this.getStatMultiplier('hunger_decay');
          if (this.state.startsWith('fsm_working')) {
             decayMult = Math.min(decayMult, 1.0); 
          }
          this.hunger += AGENT_CONFIG.DECAY.HUNGER * decayMult;
      }
      
      if (this.state !== 'fsm_sleeping') {
          const decayMult = this.getStatMultiplier('energy_decay');
          this.energy -= AGENT_CONFIG.DECAY.ENERGY * decayMult;
      }
      
      if (this.state !== 'fsm_recreation') {
          const decayMult = this.getStatMultiplier('boredom_decay');
          this.boredom = (this.boredom ?? 0) + (AGENT_CONFIG.DECAY.BOREDOM * decayMult);
      }

      if (this.state !== 'fsm_socializing') {
          const decayMult = this.getStatMultiplier('social_decay');
          this.social = (this.social ?? 0) + (AGENT_CONFIG.DECAY.SOCIAL * decayMult);
      }
      
      if (this._lastTickStress !== undefined) {
          const stressGain = this.stress - this._lastTickStress;
          if (stressGain > 1.0) {
              this.stress = this._lastTickStress + 1.0;
          }
      }

      let stressReduction = 0;
      
      if ((this.hunger ?? 0) < 50 && (this.energy ?? 0) > 50 && (this.social ?? 0) < 50) {
          stressReduction += AGENT_CONFIG.DECAY.STRESS_PASSIVE;
      }

      if (this.state === 'fsm_recreation') {
          stressReduction += AGENT_CONFIG.DECAY.STRESS_RECREATION;
      } else if (this.state === 'fsm_socializing') {
           if (this.persona?.traits?.includes('Extrovert')) {
               stressReduction += AGENT_CONFIG.DECAY.STRESS_SOCIAL;
           }
      }
      
      this.stress -= stressReduction;
      
      this.clampStats(); 
      this._lastTickStress = this.stress;
  }

  _processSenses(worldState) {}
  _updateStatusEffectsStub() {} 

  _handleMovement() {
      if (this.travelTimer > 0) {
          this.travelTimer--;
          return;
      }
      this.inTransit = false;
      this.locationId = this.destinationId;
      this.destinationId = null;
      
      const pendingState = this.fsm.pendingNextState;
      if (pendingState) {
          this.fsm.transitionTo(pendingState, { reason: 'Arrived at destination' });
          this.fsm.pendingNextState = null;
      } else {
          this.fsm.transitionTo('fsm_idle');
      }
  }

  clampStats() {
      this.hunger = Math.max(0, Math.min(100, this.hunger ?? 0));
      this.social = Math.max(0, Math.min(100, this.social ?? 0));
      this.boredom = Math.max(0, Math.min(100, this.boredom ?? 0));
      this.stress = Math.max(0, Math.min(100, this.stress ?? 0));
      this.energy = Math.max(0, Math.min(100, this.energy ?? 100));
      this.mood = Math.max(-100, Math.min(100, this.mood ?? 0));
      this.burnout = Math.max(0, Math.min(100, this.burnout ?? 0));
  }

  ensureHome() {
      if (!this.homeLocationId && worldGraph?.findRandomLocationByType) {
          const homeNode = worldGraph.findRandomLocationByType('home');
          if (homeNode) {
              this.homeLocationId = homeNode.key;
              this.rent_cost = homeNode.rent_cost || 0;
          }
      }
  }

  updateHistory() {
      this.clampStats();
      if (!this.history || Array.isArray(this.history) || typeof this.history !== 'object') {
          this.history = { mood: [], energy: [], stress: [], money: [] };
      }
      if (!Array.isArray(this.history.mood)) this.history.mood = [];
      if (!Array.isArray(this.history.energy)) this.history.energy = [];
      if (!Array.isArray(this.history.stress)) this.history.stress = [];
      if (!Array.isArray(this.history.money)) this.history.money = [];

      const pushToBuffer = (buffer, value) => {
          buffer.push(Math.round(value));
          if (buffer.length > AGENT_CONFIG.HISTORY_BUFFER_SIZE) {
              buffer.shift();
          }
      };
      
      pushToBuffer(this.history.mood, this.mood ?? 0);
      pushToBuffer(this.history.energy, this.energy ?? 0);
      pushToBuffer(this.history.stress, this.stress ?? 0);
      pushToBuffer(this.history.money, this.money ?? 0);
  }

  recordActivity(activityName) {
    if (!activityName) return;
    if (this.state !== 'fsm_idle' && this.locationId) {
        if (!this.habits) this.habits = {};
        if (!this.habits[activityName]) this.habits[activityName] = {};
        
        const currentCount = this.habits[activityName][this.locationId] || 0;
        this.habits[activityName][this.locationId] = currentCount + 1;
    }
    if (this.recentActivities.length > 0 && this.recentActivities[0] === activityName) return;
    this.recentActivities.unshift(activityName);
    if (this.recentActivities.length > AGENT_CONFIG.RECENT_ACTIVITY_BUFFER) this.recentActivities.pop();
  }
  
  updateRoutineReinforcement(activityName, locationId, dayOfWeek, hour, currentTick, socialPartnerId = null) {}

  getActiveIntention() {
    if (!this.intentionStack || this.intentionStack.length === 0) return null;
    return this.intentionStack[this.intentionStack.length - 1];
  }

  pushIntention(intention, currentTick) {
    if (!this.intentionStack) this.intentionStack = [];
    if (this.intentionStack.length >= AGENT_CONFIG.MAX_INTENTION_DEPTH) this.intentionStack.shift(); 
    const currentIntention = this.getActiveIntention();
    if (currentIntention) currentIntention.suspended = true;
    intention.initiatedTick = currentTick;
    intention.suspended = false;
    intention.context = intention.context || {}; 
    this.intentionStack.push(intention);
  }

  popIntention() {
    if (!this.intentionStack || this.intentionStack.length === 0) return;
    this.intentionStack.pop(); 
    const newActiveIntention = this.getActiveIntention();
    if (newActiveIntention) newActiveIntention.suspended = false;
  }

  updateIntentionTimeouts(currentTick) {
    if (!this.intentionStack || this.intentionStack.length === 0) return;
    this.intentionStack = this.intentionStack.filter(intention => {
      if (intention.suspended) {
        const ticksSuspended = currentTick - (intention.initiatedTick || 0);
        if (ticksSuspended > AGENT_CONFIG.INTENTION_TIMEOUT_TICKS) return false; 
      }
      return true; 
    });
  }

  getConsumableFoodItem() { return getConsumableFoodItem(this); }
  consumeItem(itemId) { return consumeItem(this, itemId); }
  hasHobbyItem(skillTag) { return hasHobbyItem(this); }
  rehydrateActivity() { return activityRehydrate(this); }
  updateCurrentActivity(newState, hour = 12) { return activityUpdate(this, newState, hour); }
  
  getRelationship(agentId) {
    if (!(this.relationships ?? {})[agentId]) return AGENT_CONFIG.DEFAULT_REL_VALUES; 
    const rel = this.relationships[agentId];
    return { 
        affinity: rel.affinity ?? 0, 
        score: rel.score ?? rel.affinity ?? 0,
        type: rel.type ?? 'acquaintance', 
        history: rel.history ?? [] 
    };
  }

  updateRelationship(agentId, affinityAmount, newType = null, historyEvent = null) {
    let current = this.getRelationship(agentId);
    const newAffinity = Math.min(100, Math.max(-100, (current.affinity ?? 0) + affinityAmount));
    let updatedType = newType || current.type;
    let history = current.history || [];
    if (historyEvent) {
        history.push(historyEvent);
        if (history.length > AGENT_CONFIG.RELATIONSHIP_HISTORY_SIZE) history.shift();
    }
    this.relationships[agentId] = { 
        affinity: newAffinity, 
        score: newAffinity, 
        type: updatedType, 
        history: history 
    };
  }

  transitionToState(newState) {
    if (this.state === newState) return { changed: false, walOp: null };
    
    this.clampStats();
    const currentTick = this.matrix?.tickCount || 0;
    this.updateIntentionTimeouts(currentTick);

    const isCommitted = (currentTick - (this.activityStartTick ?? 0)) < (this.minActivityDuration ?? 0);
    
    if (isCommitted) {
      // FIX: Added fsm_eating and fsm_seek_healthcare to emergency list
      const isEmergency = newState === 'fsm_sleeping' || newState === 'fsm_desperate' || newState === 'fsm_eating' || newState === 'fsm_seek_healthcare';
      const isMovementGoal = newState === 'fsm_commuting' || newState === 'fsm_in_transit';
      const isCurrentlyMoving = this.state === 'fsm_commuting' || this.state === 'fsm_in_transit';
      if (!isEmergency && !isMovementGoal && !isCurrentlyMoving) {
        return { changed: false, walOp: null };
      }
    }

    let walOp = null;
    const oldState = this.state; 
    const currentDay = this.matrix?.worldTime?.getDay() || null;
    const currentHour = this.matrix?.worldTime?.getHours() || null;
    const oldLocationId = this.locationId; 
    const socialPartnerId = this.lastSocialPartner; 

    this.state = newState; 
    
    if (newState === 'fsm_sleeping' || newState.startsWith('fsm_working')) {
        this.lastSocialPartner = null;
    }

    this.updateRoutineReinforcement(oldState, oldLocationId, currentDay, currentHour, currentTick, socialPartnerId);

    const currentIntention = this.getActiveIntention();
    if (currentIntention && !currentIntention.suspended && oldState === currentIntention.goal) {
      this.popIntention();
    }

    if (oldState !== 'fsm_commuting' && oldState !== 'fsm_in_transit' && oldState !== 'fsm_idle') {
        this.recordActivity(oldState);
    }

    let hourForActivity = 12; 
    if (this.matrix?.worldTime) {
      hourForActivity = new Date(this.matrix.worldTime).getHours();
    }
    this.updateCurrentActivity(newState, hourForActivity);

    this.activityStartTick = currentTick;

    let intentionDuration = 0;
    if (currentIntention && currentIntention.context && currentIntention.context.duration) {
        intentionDuration = Math.ceil(currentIntention.context.duration * 5);
    }

    if (intentionDuration > 0) {
        this.minActivityDuration = intentionDuration;
    } else {
        switch (newState) {
          case 'fsm_eating': this.minActivityDuration = 3; break;
          case 'fsm_socializing': this.minActivityDuration = 5; break;
          case 'fsm_recreation': this.minActivityDuration = 5; break; 
          case 'fsm_working_office':
          case 'fsm_working_police':
          case 'fsm_working_teacher':
          case 'fsm_working_service': this.minActivityDuration = 32; break; // Reduced from 48 to 32 (8 hours)
          case 'fsm_sleeping': this.minActivityDuration = 24; break; 
          case 'fsm_maintenance': this.minActivityDuration = 4; break;
          case 'fsm_shopping': this.minActivityDuration = 4; break;
          case 'fsm_desperate': this.minActivityDuration = 12; break;
          case 'fsm_seek_healthcare': this.minActivityDuration = 10; break; 
          case 'fsm_acquire_housing': this.minActivityDuration = 6; break; 
          default: this.minActivityDuration = 0;
        }
    }
    
    if (newState === 'fsm_eating') {
        const foodItem = this.getConsumableFoodItem();
        if (foodItem) {
            this.consumeItem(foodItem.itemId);
            walOp = { op: 'AGENT_CONSUME_FOOD', data: { itemId: foodItem.itemId } };
            
            const h = this.matrix?.worldTime ? new Date(this.matrix.worldTime).getHours() : 12;
            const isMealTime = (h >= 7 && h <= 9) || (h >= 12 && h <= 14) || (h >= 18 && h <= 20);
            
            // FIX: Guaranteed hunger reduction regardless of meal time
            this.hunger = Math.max(0, this.hunger - 25); 

            if (isMealTime) {
                this.mood = Math.min(100, this.mood + 5); 
                this.stress = Math.max(0, this.stress - 5);
                this.hunger = Math.max(0, this.hunger - 10); // Bonus reduction for proper meal times
            }
        } else {
            this.state = 'fsm_idle';
            this.minActivityDuration = 0;
            return this.transitionToState('fsm_idle'); 
        }
    }
    
    if (newState === 'fsm_socializing') this.socializingTicks = 0;

    if (newState === 'fsm_homeless') {
      this.homeLocationId = null;
      this.homeNode = null; 
      this.rent_cost = 0;
      this.rentFailures = 0; 
    }
    
    if (newState !== 'fsm_commuting' && newState !== 'fsm_in_transit') {
      this.targetLocationId = null;
      this.transitFrom = null;
      this.transitTo = null;
      this.travelTimer = 0;
    }
    
    return { changed: true, walOp: walOp };
  }
  
  serialize() {
    const sanitize = (val) => val === undefined ? null : val;
    const activeIntention = this.getActiveIntention();
    this.clampStats();

    return {
      id: sanitize(this.id), 
      name: sanitize(this.name),
      hunger: sanitize(this.hunger) ?? 0, 
      energy: sanitize(this.energy) ?? 100, 
      social: sanitize(this.social) ?? 0,
      money: Math.round(sanitize(this.money) ?? 0),
      state: sanitize(this.state) || 'fsm_idle', 
      // [REF] Serialize stateContext to DB
      stateContext: this.stateContext,
      lod: sanitize(this.lod) ?? 2, 
      nextTick: sanitize(this.nextTick) ?? 0,
      locationId: sanitize(this.locationId),
      isMetasim: this.isMetasim ? 1 : 0, 
      
      persona: this.persona,
      homeLocationId: sanitize(this.homeLocationId),
      workLocationId: sanitize(this.workLocationId),
      rent_cost: sanitize(this.rent_cost),
      targetLocationId: sanitize(this.targetLocationId),
      currentGoal: sanitize(activeIntention ? activeIntention.goal : null),
      job: this.job, 
      interests: this.interests,
      currentActivity: sanitize(this.currentActivity),
      currentActivityName: sanitize(this.currentActivityName) || 'Idling',
      travelTimer: sanitize(this.travelTimer) ?? 0,
      transitFrom: sanitize(this.transitFrom),
      transitTo: sanitize(this.transitTo),
      inventory: this.inventory, 
      mood: sanitize(this.mood) ?? 0,
      stress: sanitize(this.stress) ?? 0,
      boredom: sanitize(this.boredom) ?? 0,
      burnout: sanitize(this.burnout) ?? 0,
      financial: this.financial,
      habits: this.habits,
      socialState: this.socialState, 
      status_effects: this.status_effects,
      relationships: this.relationships, 
      skills: this.skills,
      aspiration: this.aspiration,
      partnerId: sanitize(this.partnerId),
      rentFailures: sanitize(this.rentFailures) ?? 0,
      activityStartTick: sanitize(this.activityStartTick) ?? 0,
      minActivityDuration: sanitize(this.minActivityDuration) ?? 0,
      recentActivities: this.recentActivities,
      routines: this.routines,
      contextualRoutines: this.contextualRoutines,
      intentionStack: this.intentionStack,
      beliefs: this.beliefs, 
      intentionPlan: this.intentionPlan,
      history: this.history,
      perceivedAgents: this.perceivedAgents,
      perceivedCrowding: (typeof this.perceivedCrowding === 'string') ? this.perceivedCrowding : 'empty',
      circadianBias: sanitize(this.circadianBias), 
    };
  }

  toString() {
    const metaTag = this.isMetasim ? '[M] ' : '';
    let locationName = this.locationId || 'N/A';
    let homeName = this.homeLocationId || 'Homeless'; 
    let stateStr = this.currentActivity || this.state;
    if (this.state === 'fsm_in_transit') {
      stateStr = `TRANSIT (${this.travelTimer ?? 0}t)`;
    } else if (this.state === 'fsm_commuting' && this.targetLocationId) {
      const intention = this.getActiveIntention();
      const goalName = intention ? intention.goal.replace('fsm_', '') : '...';
      stateStr = `COMMUTE->${goalName}`;
    }
    const needs = `(H:${Math.round(this.hunger ?? 0)} E:${Math.round(this.energy ?? 0)} S:${Math.round(this.social ?? 0)} M:${Math.round(this.money ?? 0)})`;
    return `${metaTag}[${this.name.padEnd(18)}] @ ${locationName.padEnd(25)} [Home:${homeName}] ${stateStr.padEnd(20)} ${needs}`;
  }
}
export default Agent;