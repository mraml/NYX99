import { BaseState } from './BaseState.js';
import { GAME_BALANCE } from '../../data/balance.js';
import worldGraph from '../../data/worldGraph.js'; 
import eventBus from '../../engine/eventBus.js';

// Removed hardcoded theme arrays
const SLEEP_CONFIG = {
    BASE_REGEN: 5.0,
    DEEP_SLEEP_MULTIPLIER: 1.5,
    REM_THRESHOLD_TICKS: 10,
    WAKE_THRESHOLD: 99.5,
    NOISE_PENALTY_THRESHOLD: 0.4,
    NOISE_WAKE_THRESHOLD: 0.85,
    BAD_CONDITION_THRESHOLD: 50,
    NIGHTMARE_STRESS_THRESHOLD: 60,
    IDEAL_TEMP_MIN: 18,
    IDEAL_TEMP_MAX: 24
};

export class SleepingState extends BaseState {
    // [REF] Stateless Architecture: Removed constructor

    // [REF] Added agent param
    enter(agent) {
        super.enter(agent);
        this._updateActivityFromState(agent);
        
        // [REF] Move stateful properties to agent.stateContext
        agent.stateContext.sleepDepthTicks = 0; 
        
        const startingEnergy = agent.energy || 0;
        agent.stateContext.initialFatigue = Math.max(0, 100 - startingEnergy);
        agent.stateContext.sleepEfficiency = 0.75 + (agent.stateContext.initialFatigue / 200);
        agent.stateContext.ticksToDeepSleep = Math.max(2, SLEEP_CONFIG.REM_THRESHOLD_TICKS - Math.floor(agent.stateContext.initialFatigue / 10));

        if (!agent.circadianBias) {
            this._initCircadianRhythm(agent);
        }

        const isHomeless = !agent.homeLocationId || agent.locationId !== agent.homeLocationId;
        
        if (isHomeless) {
            this.log(`[${agent.name}] Sleeping in poor conditions.`);
        } else if (agent.stateContext.initialFatigue > 80) {
            this.log(`[${agent.name}] Crashed immediately due to exhaustion.`);
        }
    }

    _initCircadianRhythm(agent) {
        const p = agent.persona || {};
        const score = (p.conscientiousness || 0.5) - (p.openness || 0.5);
        agent.circadianBias = score > 0 ? 6 : 10; 
    }

    // [REF] Added agent param
    tick(agent, hour, localEnv, worldState) {
        // SAFETY: Initialization check needed since we removed the previous logic block
         if (agent.stateContext.sleepEfficiency === undefined) {
             agent.stateContext.sleepEfficiency = 1.0;
             agent.stateContext.ticksToDeepSleep = 10;
             agent.stateContext.initialFatigue = 0;
             agent.stateContext.sleepDepthTicks = 0;
         }
        
        super.tick(agent, hour, localEnv, worldState, { skipEnergy: true, skipBoredom: true, skipStressCalculation: true });
        
        agent.stateContext.sleepDepthTicks++;
        
        let isDirty = (worldState.currentTick % 30 === 0);

        if ((agent.stress ?? 0) > 50) {
            const restlessness = (agent.stress - 50) / 200; 
            if (Math.random() < restlessness) {
                if (agent.stateContext.sleepDepthTicks > agent.stateContext.ticksToDeepSleep) {
                    agent.stateContext.sleepDepthTicks = 0; 
                    if (Math.random() < 0.2) this.log(`[${agent.name}] Experienced sleep disturbance.`);
                }
            }
        }

        const quality = this._calculateSleepQuality(localEnv, agent);
        this._applyRegeneration(agent, quality);
        this._handleSickness(agent);

        if (Math.random() < 0.008) {
            const wakeFromNightmare = this._handleDreams(agent, worldState.currentTick);
            if (wakeFromNightmare) {
                return this.wakeUp(agent, 'Woke up from a highly stressful dream.');
            }
        }

        const wakeReason = this._checkWakeConditions(agent, hour, localEnv);
        if (wakeReason) {
            return this.wakeUp(agent, wakeReason);
        }

        return { isDirty, walOp: null };
    }

    // [REF] Added agent param
    _calculateSleepQuality(localEnv, agent) {
        let quality = 1.0;
        if ((localEnv.noise ?? 0) > SLEEP_CONFIG.NOISE_PENALTY_THRESHOLD) quality -= 0.25;
        if ((localEnv.condition ?? 100) < SLEEP_CONFIG.BAD_CONDITION_THRESHOLD) quality *= 0.9;

        const temp = localEnv.temperature ?? 20;
        if (temp < SLEEP_CONFIG.IDEAL_TEMP_MIN || temp > SLEEP_CONFIG.IDEAL_TEMP_MAX) quality *= 0.85; 

        const isHomeless = !agent.homeLocationId || agent.locationId !== agent.homeLocationId;
        if (isHomeless) {
            quality *= 0.8;
            if (quality < 0.5 && Math.random() < 0.1) {
                agent.stress = Math.min(100, (agent.stress ?? 0) + 1);
            }
        }
        return Math.max(0.1, quality); 
    }

    // [REF] Added agent param
    _applyRegeneration(agent, quality) {
        // [REF] Use stateContext
        const deepSleepBonus = agent.stateContext.sleepDepthTicks > agent.stateContext.ticksToDeepSleep ? SLEEP_CONFIG.DEEP_SLEEP_MULTIPLIER : 1.0;
        
        const effectiveRegen = Math.max(0.1, SLEEP_CONFIG.BASE_REGEN * deepSleepBonus * quality * (agent.stateContext.sleepEfficiency || 1.0));
        
        const stressRegen = 2.0; 
        const moodRegen = 1.0;

        agent.energy = Math.min(100, (agent.energy ?? 0) + effectiveRegen);
        agent.stress = Math.max(0, (agent.stress ?? 0) - (stressRegen * quality)); 
        agent.boredom = Math.max(0, (agent.boredom ?? 0) - (4 * quality)); 
        agent.mood = Math.min(100, (agent.mood ?? 0) + (moodRegen * quality));
    }

    // [REF] Added agent param
    _handleSickness(agent) {
        if (!agent.status_effects) return;
        const sickEffect = agent.status_effects.find(e => e.type === 'SICK');
        if (sickEffect) {
            sickEffect.duration -= 2; 
            if (sickEffect.duration <= 0) {
                agent.status_effects = agent.status_effects.filter(e => e.type !== 'SICK');
                this.log(`[${agent.name}] Recovered from illness while sleeping.`);
            }
        }
    }

    // [REF] Added agent param
    _handleDreams(agent, currentTick) {
        const p = agent.persona || {};
        const openness = p.openness || 0.5;
        if (Math.random() < (0.01 * openness)) {
             agent.mood = Math.min(100, (agent.mood ?? 0) + 20); 
             agent.boredom = 0; 
             eventBus.emit('db:writeMemory', 'high', agent.id, currentTick, `Had a positive, memorable dream.`);
             return false;
        }

        let nightmareChance = 0.05;
        if ((agent.stress ?? 0) > SLEEP_CONFIG.NIGHTMARE_STRESS_THRESHOLD) nightmareChance = 0.6; 

        const isNightmare = Math.random() < nightmareChance;
        // Removed hardcoded theme list

        if (isNightmare) {
            agent.stress = Math.min(100, (agent.stress ?? 0) + 15);
            agent.mood = Math.max(0, (agent.mood ?? 0) - 10);
            eventBus.emit('db:writeMemory', 'low', agent.id, currentTick, `Was woken by a nightmare.`);
            if (Math.random() < 0.3) return true; 
        } else {
            agent.mood = Math.min(100, (agent.mood ?? 0) + 5);
            agent.stress = Math.max(0, (agent.stress ?? 0) - 2);
            eventBus.emit('db:writeMemory', 'low', agent.id, currentTick, `Experienced a restful dream.`);
        }
        return false; 
    }

    // [REF] Added agent param
    _checkWakeConditions(agent, hour, localEnv) {
        const energy = agent.energy ?? 0;
        const isFullyRested = energy >= SLEEP_CONFIG.WAKE_THRESHOLD;
        const isUrgentNeed = (agent.hunger ?? 0) > 90;
        
        // [REF] Use stateContext
        const isDeadToTheWorld = (agent.stateContext.initialFatigue > 80 && agent.stateContext.sleepDepthTicks < 60);

        if (!isDeadToTheWorld && (localEnv.noise ?? 0) > SLEEP_CONFIG.NOISE_WAKE_THRESHOLD) {
            return 'Woke up due to loud noise.';
        }

        if (isUrgentNeed) return 'Woke up from urgent need.';

        const isWorkSoon = agent.job && agent.job.startHour && 
                           (agent.job.startHour - hour <= 1) && 
                           (agent.job.startHour > hour);
        
        if (isWorkSoon) {
             const exhaustionFactor = (100 - energy) / 100; 
             const discipline = (agent.persona?.conscientiousness || 0.5);
             let snoozeChance = 0.05 + (exhaustionFactor * 0.3) - (discipline * 0.2);
             snoozeChance = Math.max(0, snoozeChance);

             if (Math.random() > snoozeChance) {
                 return 'Woke up for work.';
             } else {
                 if (Math.random() < 0.05) this.log(`[${agent.name}] Snoozing alarm.`);
             }
        }

        if (isFullyRested) {
            const wakeTarget = agent.circadianBias || 7;
            const isMorning = hour >= wakeTarget && hour < (wakeTarget + 3);
            
            if (isMorning) return 'Woke up fully rested.';

            const isNight = hour >= 22 || hour < 6;
            if (isNight) {
                if (Math.random() < 0.05) return 'Woke up early.';
                return null; 
            } else {
                return 'Woke up from nap.';
            }
        }
        
        return null; 
    }

    // [REF] Added agent param
    wakeUp(agent, reason) {
        this.log(`[${agent.name}] Waking up: ${reason}`);
        
        if (reason.includes('rested') || reason.includes('nap')) {
            if (!agent.status_effects) agent.status_effects = [];
            agent.status_effects = agent.status_effects.filter(e => e.type !== 'EXHAUSTED');
            // FIX: Completed the truncated calculation line
            const buffMagnitude = (agent.stateContext.sleepEfficiency || 1.0) > 1.0 ? 0.7 : 0.8; 
            agent.status_effects.push({ type: 'WELL_RESTED', duration: 240, magnitude: buffMagnitude });
        }
        if (reason.includes('nightmare') || reason.includes('noise')) {
            if (!agent.status_effects) agent.status_effects = [];
            agent.status_effects.push({ type: 'GROGGY', duration: 60, magnitude: 1.2 });
        }

        const currentIntention = agent.intentionStack?.[agent.intentionStack.length - 1];
        if (currentIntention && currentIntention.goal === 'fsm_sleeping') {
            agent.intentionStack.pop();
        }

        // Return the transition instruction
        return { isDirty: true, nextState: 'fsm_idle' };
    }
    
    // Correcting tick to use the return value
    tick(agent, hour, localEnv, worldState) {
        // SAFETY: Initialization check needed since we removed the previous logic block
         if (agent.stateContext.sleepEfficiency === undefined) {
             agent.stateContext.sleepEfficiency = 1.0;
             agent.stateContext.ticksToDeepSleep = 10;
             agent.stateContext.initialFatigue = 0;
             agent.stateContext.sleepDepthTicks = 0;
         }
        
        super.tick(agent, hour, localEnv, worldState, { skipEnergy: true, skipBoredom: true, skipStressCalculation: true });
        
        agent.stateContext.sleepDepthTicks++;
        
        let isDirty = (worldState.currentTick % 30 === 0);

        if ((agent.stress ?? 0) > 50) {
            const restlessness = (agent.stress - 50) / 200; 
            if (Math.random() < restlessness) {
                if (agent.stateContext.sleepDepthTicks > agent.stateContext.ticksToDeepSleep) {
                    agent.stateContext.sleepDepthTicks = 0; 
                    if (Math.random() < 0.2) this.log(`[${agent.name}] Experienced sleep disturbance.`);
                }
            }
        }

        const quality = this._calculateSleepQuality(localEnv, agent);
        this._applyRegeneration(agent, quality);
        this._handleSickness(agent);

        if (Math.random() < 0.008) {
            const wakeFromNightmare = this._handleDreams(agent, worldState.currentTick);
            if (wakeFromNightmare) {
                return this.wakeUp(agent, 'Woke up from a highly stressful dream.');
            }
        }

        const wakeReason = this._checkWakeConditions(agent, hour, localEnv);
        if (wakeReason) {
            return this.wakeUp(agent, wakeReason);
        }

        return { isDirty, walOp: null };
    }
}