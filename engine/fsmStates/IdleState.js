import { BaseState } from './BaseState.js';
import { Selector, Sequence, Condition, Action, Status } from '../BehaviorTreeCore.js';
import { isAgentWorkShift, transitionWithCommuteIfNeeded } from '../agentUtilities.js';
import eventBus from '../eventBus.js';
import worldGraph from '../../data/worldGraph.js';
import { GAME_BALANCE } from '../../data/balance.js';
import {
  ENABLE_ADVANCED_IDLE_SCORING,
  ENABLE_CIRCADIAN_BIAS_SCORING,
} from '../../data/config.js';

function isValidPlan(plan) {
    return !!plan && typeof plan === 'object' && typeof plan.type === 'string' && Number.isFinite(plan.tick);
}

function isExecutableMeetPlan(plan) {
    return plan.type === 'MEET_AGENT' &&
        typeof plan.locationId === 'string' &&
        plan.locationId.length > 0 &&
        typeof plan.targetAgentId === 'string' &&
        plan.targetAgentId.length > 0;
}

function getDayProfile(hour = 12) {
    const day = worldGraph.currentDay ?? 0;
    const isWeekend = day === 0 || day === 6;
    const isEvening = hour >= 18 || hour < 2;
    const isLateNight = hour >= 23 || hour < 4;
    return { isWeekend, isEvening, isLateNight, day };
}

function ensureOutingState(agent) {
    if (!agent.stateContext) agent.stateContext = {};
    if (!Number.isFinite(agent.stateContext.lastOutingTick)) {
        agent.stateContext.lastOutingTick = -9999;
    }
    if (!Number.isFinite(agent.stateContext.lastGroceryTick)) {
        agent.stateContext.lastGroceryTick = -9999;
    }
}

// === 1. LEAF NODES ===

const Actions = {
    // Consolidated "Check Needs" Action
    EvaluateNeeds: (agent, { hour, worldState }) => {
        const LC = GAME_BALANCE.LIFECYCLE;
        const CB = GAME_BALANCE.CIRCADIAN_IDLE;

        if (!agent.stateContext) agent.stateContext = {};
        const onShift = isAgentWorkShift(agent, hour);
        if (!onShift) {
            if (agent.stateContext.workSessionDone) agent.stateContext.workSessionDone = false;
            if (agent.stateContext.lunchBreakTaken) agent.stateContext.lunchBreakTaken = false;
        }
        
        let hungerScore = agent.hunger || 0;
        const isMealTime = (hour >= 7 && hour <= 9) || (hour >= 12 && hour <= 14) || (hour >= 18 && hour <= 20);
        
        if (isMealTime) hungerScore *= 1.5;
        if (hungerScore > 90) hungerScore *= 2.0; 

        let energyScore = 100 - (agent.energy || 0);
        const isNight = (hour >= 23 || hour < 6);
        
        if (isNight) energyScore *= 2.0; 
        if (energyScore > 90) energyScore *= 2.0;

        if (ENABLE_CIRCADIAN_BIAS_SCORING && agent.circadianBias) {
            const { peakHour = 14, troughHour = 4, biasStrength = 1.2 } = agent.circadianBias;
            const dPeak = Math.min(Math.abs(hour - peakHour), 24 - Math.abs(hour - peakHour));
            const dTrough = Math.min(Math.abs(hour - troughHour), 24 - Math.abs(hour - troughHour));
            const mealBoost = isMealTime ? (CB.MEAL_PEAK_BOOST ?? 1.25) : (CB.MEAL_OFF_HOURS ?? 0.85);
            hungerScore *= mealBoost * (1 + (1 - dPeak / 12) * 0.12 * (biasStrength / 1.2));
            energyScore *= (1 + (1 - dTrough / 12) * 0.15 * (biasStrength / 1.2));
            if (!isNight) energyScore *= (CB.SLEEP_PEAK_REDUCTION ?? 0.9);
        }

        // 2. Pick the Winner
        const THRESHOLD = GAME_BALANCE.THRESHOLDS.ACTION_THRESHOLD;
        
        let winner = null;
        let maxScore = -1;

        if (ENABLE_ADVANCED_IDLE_SCORING) {
            const wH = LC.IDLE_WEIGHT_HUNGER_ENERGY ?? 1;
            const wL = LC.IDLE_WEIGHT_LONELINESS ?? 0.85;
            const wB = LC.IDLE_WEIGHT_BOREDOM ?? 0.75;
            const lonelinessScore = (100 - (agent.social ?? 0)) * wL;
            const boredomScore = (agent.boredom ?? 0) * wB;

            const candidates = [
                { key: 'eat', score: hungerScore * wH },
                { key: 'sleep', score: energyScore * wH },
                { key: 'social', score: lonelinessScore },
                { key: 'fun', score: boredomScore },
            ];
            for (const c of candidates) {
                if (c.score > THRESHOLD && c.score > maxScore) {
                    winner = c.key;
                    maxScore = c.score;
                }
            }
        } else {
            if (hungerScore > THRESHOLD && hungerScore > maxScore) {
                winner = 'eat';
                maxScore = hungerScore;
            }
            if (energyScore > THRESHOLD && energyScore > maxScore) {
                winner = 'sleep';
                maxScore = energyScore;
            }
        }
        
        // Survival Override (Critical Needs bypass work shift)
        const isCriticalHunger = hungerScore > GAME_BALANCE.THRESHOLDS.CRITICAL_HUNGER;
        const isCriticalEnergy = energyScore > GAME_BALANCE.THRESHOLDS.CRITICAL_ENERGY_SCORE;
        
        if (isCriticalHunger) {
            return transitionWithCommuteIfNeeded(agent, 'fsm_eating', { reason: 'critical_need', currentTick: worldState.currentTick });
        }
        if (isCriticalEnergy) {
            return { isDirty: true, nextState: 'fsm_sleeping' };
        }

        // Elder -> Retired state instead of work
        if (agent.lifeStage === 'elder') {
            return { isDirty: true, nextState: 'fsm_retired' };
        }

        // Children don't work
        if (agent.lifeStage === 'child') {
            if (winner === 'eat') return transitionWithCommuteIfNeeded(agent, 'fsm_eating', { reason: 'child_need', currentTick: worldState.currentTick });
            if (winner === 'sleep') return { isDirty: true, nextState: 'fsm_sleeping' };
            if (winner === 'social') return transitionWithCommuteIfNeeded(agent, 'fsm_socializing', { reason: 'child_social', currentTick: worldState.currentTick });
            if (winner === 'fun') return transitionWithCommuteIfNeeded(agent, 'fsm_recreation', { reason: 'child_play', currentTick: worldState.currentTick });
            return Status.FAILURE;
        }

        // At home, not ready: block work/needs winners until prep window passes.
        // Day shifts: no dispatch before workStartHour. Overnight (start>end): skip pre-start gate.
        if (agent.locationId === agent.homeLocationId && !agent.stateContext.isReadyForDay) {
            const start = agent.workStartHour ?? 9;
            const end = agent.workEndHour ?? 17;
            const isOvernightShift = start > end;
            if (!isOvernightShift && hour < start) {
                return Status.FAILURE;
            }
            if (hour >= 6 && hour <= 10) {
                return Status.FAILURE;
            }
        }

        // Work Override (skip if already left for the day / burnout until shift window resets)
        if (!agent.stateContext.workSessionDone && isAgentWorkShift(agent, hour)) {
            return transitionWithCommuteIfNeeded(agent, 'fsm_working', { reason: 'work_shift', currentTick: worldState.currentTick });
        }

        if (winner === 'eat') return transitionWithCommuteIfNeeded(agent, 'fsm_eating', { reason: 'need', currentTick: worldState.currentTick });
        if (winner === 'sleep') return { isDirty: true, nextState: 'fsm_sleeping' };
        if (winner === 'social') return transitionWithCommuteIfNeeded(agent, 'fsm_socializing', { reason: 'loneliness', currentTick: worldState.currentTick });
        if (winner === 'fun') return transitionWithCommuteIfNeeded(agent, 'fsm_recreation', { reason: 'boredom_need', currentTick: worldState.currentTick });
        
        return Status.FAILURE; 
    },

    SeekHousing: (agent) => {
        if (agent.lod === 1) console.log(`[${agent.name}] Idle and homeless. Looking for home.`);
        return { isDirty: true, nextState: 'fsm_acquire_housing' };
    },
    
    SeekMaintenance: (agent) => {
        return { isDirty: true, nextState: 'fsm_maintenance' };
    },

    GoHome: (agent, { worldState }) => {
        if (!agent.homeLocationId) return Status.FAILURE;
        return transitionWithCommuteIfNeeded(agent, 'fsm_idle', {
            reason: 'going_home',
            destination: agent.homeLocationId,
            currentTick: worldState.currentTick,
        });
    },

    // NEW: Morning Routine Actions
    DoMorningRoutine: (agent) => {
        // Simple sequential routine simulation
        if (!agent.stateContext.morningRoutineStep) {
            agent.stateContext.morningRoutineStep = 'shower';
        }

        const step = agent.stateContext.morningRoutineStep;
        
        if (step === 'shower') {
            agent.currentActivityName = 'taking shower'; // Matches activities.yaml
            agent.stateContext.morningRoutineStep = 'brush_teeth';
            // Flavor log
            if (agent.lod === 1) console.log(`[${agent.name}] Taking a morning shower.`);
            return Status.RUNNING; // Take a tick to do this
        } else if (step === 'brush_teeth') {
            agent.currentActivityName = 'brushing teeth';
            agent.stateContext.morningRoutineStep = 'dress';
            return Status.RUNNING;
        } else if (step === 'dress') {
            agent.currentActivityName = 'getting dressed';
            agent.stateContext.morningRoutineStep = 'done';
            // Mark as "Ready" for the day
            agent.stateContext.isReadyForDay = true;
            return Status.RUNNING;
        } 
        
        return Status.SUCCESS; // Routine complete
    },

    SeekFun: (agent, { hour, worldState }) => {
        ensureOutingState(agent);
        const profile = getDayProfile(hour);
        const isExtrovert = (agent.persona?.extroversion ?? 0.5) > 0.6;
        const socialChance = isExtrovert ? 0.7 : 0.35;
        const nightlifeChance = profile.isEvening ? 0.4 : 0.1;
        agent.stateContext.lastOutingTick = worldState.currentTick;
        if (Math.random() < nightlifeChance) {
            return transitionWithCommuteIfNeeded(agent, 'fsm_socializing', {
                reason: 'planned_nightlife',
                outingIntent: 'nightlife',
                currentTick: worldState.currentTick
            });
        }
        if (Math.random() < socialChance) {
            return transitionWithCommuteIfNeeded(agent, 'fsm_socializing', {
                reason: 'bored_extrovert',
                outingIntent: profile.isEvening ? 'nightlife' : 'casual_social',
                currentTick: worldState.currentTick
            });
        }
        const recreationIntent = profile.isEvening && Math.random() < 0.45 ? 'movie_night' : 'casual_fun';
        return transitionWithCommuteIfNeeded(agent, 'fsm_recreation', {
            reason: 'bored',
            outingIntent: recreationIntent,
            currentTick: worldState.currentTick
        });
    },

    SeekGroceries: (agent, { worldState }) => {
        ensureOutingState(agent);
        agent.stateContext.lastOutingTick = worldState.currentTick;
        return transitionWithCommuteIfNeeded(agent, 'fsm_shopping', {
            reason: 'routine_groceries',
            shoppingPurpose: 'groceries',
            currentTick: worldState.currentTick
        });
    },

    SeekPlannedOuting: (agent, { hour, worldState }) => {
        ensureOutingState(agent);
        const profile = getDayProfile(hour);
        const extroversion = agent.persona?.extroversion ?? 0.5;
        const openness = agent.persona?.openness ?? 0.5;

        const roll = Math.random();
        let targetState = 'fsm_recreation';
        let outingIntent = 'casual_fun';

        if (profile.isEvening && extroversion > 0.55 && roll < 0.45) {
            targetState = 'fsm_socializing';
            outingIntent = 'nightlife';
        } else if ((profile.isWeekend || profile.isEvening) && openness > 0.45 && roll < 0.70) {
            targetState = 'fsm_recreation';
            outingIntent = 'movie_night';
        } else if (roll < 0.82) {
            targetState = 'fsm_socializing';
            outingIntent = 'casual_social';
        }

        agent.stateContext.lastOutingTick = worldState.currentTick;
        return transitionWithCommuteIfNeeded(agent, targetState, {
            reason: 'planned_outing',
            outingIntent,
            currentTick: worldState.currentTick
        });
    },

    ExecutePlan: (agent, { worldState }) => {
        const plan = agent.plans[0];
        if (!isValidPlan(plan)) {
            agent.plans.shift();
            return Status.FAILURE;
        }

        if (isExecutableMeetPlan(plan) && worldGraph.nodes[plan.locationId]) {
            agent.plans.shift(); // Consume only when executable
            agent.targetLocationId = plan.locationId;
            agent.partnerId = plan.targetAgentId;
            agent.intentionStack = [{ goal: 'fsm_socializing' }];
            if (agent.lod === 1) console.log(`[${agent.name}] Executing plan to meet agent at ${plan.locationId}`);
            return { isDirty: true, nextState: 'fsm_commuting' };
        }
        // Drop malformed or non-executable plan to avoid retry loops.
        agent.plans.shift();
        return Status.FAILURE;
    },

    DoIdleBehavior: (agent, { localEnv, worldState }) => {
        const patience = agent.persona?.conscientiousness ?? 0.5;
        let boredomPenalty = (patience < 0.3) ? 4.0 : 2.0;
        agent.boredom = Math.max(0, (agent.boredom ?? 0) - boredomPenalty);

        if ((agent.perceivedAgents?.length || 0) > 0) {
            agent.boredom += 0.5;
        }

        if (!agent.currentActivityName || agent.currentActivityName === 'idling') {
             // Use valid activities from yaml
             const idleActs = ['making coffee', 'reading newspaper', 'checking email', 'listening to music'];
             agent.currentActivityName = idleActs[Math.floor(Math.random() * idleActs.length)];
        }

        return Status.SUCCESS;
    }
};

const Conditions = {
    HasPlan: (agent, { worldState }) => {
        if (!agent.plans || agent.plans.length === 0) return false;
        // Drop stale/malformed plans so they do not churn forever.
        agent.plans = agent.plans.filter((plan) => {
            if (!isValidPlan(plan)) return false;
            return plan.tick >= worldState.currentTick - 96;
        });
        if (agent.plans.length === 0) return false;
        agent.plans.sort((a, b) => a.tick - b.tick);
        // Plan is active if we are within 20 ticks (5 hours) of the time, or past it
        return worldState.currentTick >= agent.plans[0].tick - 20;
    },

    IsHomeless: (agent) => !agent.homeLocationId,
    
    IsHouseDirty: (agent) => {
        if (!agent.homeLocationId || agent.locationId !== agent.homeLocationId) return false;
        const node = worldGraph.nodes[agent.homeLocationId];
        return node && node.condition < 40;
    },

    ShouldGoHome: (agent, { hour }) => {
        if (!agent.homeLocationId) return false;
        if (agent.locationId === agent.homeLocationId) return false;
        const h = Math.floor(hour ?? 12);
        const end = agent.workEndHour ?? 17;
        return h >= end && h < 23;
    },

    // NEW: Check if we just woke up and need to get ready
    NeedsMorningRoutine: (agent, { hour }) => {
        // Reset "Ready" flag at night (e.g., 4 AM)
        if (hour === 4) agent.stateContext.isReadyForDay = false;

        return (
            hour >= 4 &&
            hour <= 10 &&
            !agent.stateContext.isReadyForDay &&
            agent.locationId === agent.homeLocationId
        );
    },

    IsBored: (agent) => (agent.boredom ?? 0) >= (GAME_BALANCE.THRESHOLDS.BOREDOM_TO_GO_OUT ?? 35),
    NeedsGroceries: (agent, { worldState }) => {
        ensureOutingState(agent);
        const hunger = agent.hunger ?? 0;
        const minMoney = GAME_BALANCE.COSTS.GROCERIES ?? 15;
        const sinceLast = worldState.currentTick - agent.stateContext.lastGroceryTick;
        const interval = GAME_BALANCE.THRESHOLDS.GROCERY_TRIP_INTERVAL_TICKS ?? 160;
        if ((agent.money ?? 0) < minMoney) return false;
        return sinceLast >= interval && hunger > 25;
    },
    ShouldPlanOuting: (agent, { hour, worldState }) => {
        ensureOutingState(agent);
        const boredom = agent.boredom ?? 0;
        const profile = getDayProfile(hour);
        const minGap = GAME_BALANCE.THRESHOLDS.OUTING_COOLDOWN_TICKS ?? 20;
        const sinceLastOuting = worldState.currentTick - agent.stateContext.lastOutingTick;
        if (sinceLastOuting < minGap) return false;
        let chance = (profile.isEvening ? 0.18 : 0.05) + ((agent.persona?.openness ?? 0.5) * 0.15);
        if (profile.isWeekend) chance += 0.10;
        if (boredom >= (GAME_BALANCE.THRESHOLDS.BOREDOM_TO_GO_OUT ?? 35)) chance += 0.22;
        if (profile.isLateNight) chance *= 0.5;
        return Math.random() < chance;
    }
};

// === 2. BEHAVIOR TREE ===

const IdleTree = new Selector([
    // 0. Priority: Plans & Commitments
    new Sequence([
        new Condition(Conditions.HasPlan),
        new Action(Actions.ExecutePlan)
    ]),

    // 1. Critical Survival (Homelessness)
    new Sequence([
        new Condition(Conditions.IsHomeless),
        new Action(Actions.SeekHousing)
    ]),

    // 2. Needs & Obligations Evaluation (The "Brain")
    new Action(Actions.EvaluateNeeds),

    // 3. Morning Routine (Before fun/chores)
    new Sequence([
        new Condition(Conditions.NeedsMorningRoutine),
        new Action(Actions.DoMorningRoutine)
    ]),

    // 4. Maintenance (Chores)
    new Sequence([
        new Condition(Conditions.IsHouseDirty),
        new Action(Actions.SeekMaintenance)
    ]),

    // 4b. Post-shift commute home
    new Sequence([
        new Condition(Conditions.ShouldGoHome),
        new Action(Actions.GoHome)
    ]),

    // 5. Recreation (Boredom)
    new Sequence([
        new Condition(Conditions.NeedsGroceries),
        new Action(Actions.SeekGroceries)
    ]),

    // 6. Planned outings to keep life varied
    new Sequence([
        new Condition(Conditions.ShouldPlanOuting),
        new Action(Actions.SeekPlannedOuting)
    ]),

    // 7. Recreation (Boredom)
    new Sequence([
        new Condition(Conditions.IsBored),
        new Action(Actions.SeekFun)
    ]),

    // 8. Default
    new Action(Actions.DoIdleBehavior)
]);

// === 3. STATE CLASS ===

export class IdleState extends BaseState {
    enter(agent) {
        super.enter(agent);
        this._updateActivityFromState(agent);
        ensureOutingState(agent);
        // Ensure routine step is reset if we enter idle from sleep
        if (agent.stateContext.isReadyForDay === undefined) {
            agent.stateContext.isReadyForDay = false;
        }
        agent.stateContext.morningRoutineStep = null;
    }

    tick(agent, hour, localEnv, worldState) {
        super.tick(agent, hour, localEnv, worldState); 

        const context = { hour, localEnv, worldState, transition: null };
        const status = IdleTree.execute(agent, context);

        if (context.transition) return context.transition;

        return { isDirty: (worldState.currentTick % 10 === 0), walOp: null };
    }
}