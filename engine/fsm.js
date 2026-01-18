import { IdleState } from './fsmStates/IdleState.js';
import { SleepingState } from './fsmStates/SleepingState.js';
import { EatingState } from './fsmStates/EatingState.js';
import { WorkingState } from './fsmStates/WorkingState.js';
import { ShoppingState } from './fsmStates/ShoppingState.js';
import { SocializingState } from './fsmStates/SocializingState.js';
import { RecreationState } from './fsmStates/RecreationState.js';
import { MaintenanceState } from './fsmStates/MaintenanceState.js';
import { CommutingState } from './fsmStates/CommutingState.js';
import { AcquireHousingState } from './fsmStates/AcquireHousingState.js';
import { DesperateState } from './fsmStates/DesperateState.js';
import { GAME_BALANCE } from '../data/balance.js';
import eventBus from '../engine/eventBus.js';

// Map exports to Balance file for centralized tuning
export const SOCIALIZE_REGEN_PER_TICK_FIXED = GAME_BALANCE.REGEN.SOCIALIZE || 5;
export const STRESS_REDUCTION_PER_TICK_FIXED = 0.5;
export const EAT_REGEN_PER_TICK_FIXED = GAME_BALANCE.REGEN.EAT || 20;

// Critical Thresholds
export const CRITICAL_ENERGY_THRESHOLD = GAME_BALANCE.THRESHOLDS?.CRITICAL_ENERGY || 5;
export const STARVATION_THRESHOLD = GAME_BALANCE.THRESHOLDS?.STARVATION || 98;

// === STATE REGISTRY (FLYWEIGHT PATTERN) ===
// Instantiate all states once. They are stateless singletons.
const STATE_REGISTRY = {
    // --- BIOLOGICAL / SURVIVAL ---
    'fsm_sleeping': new SleepingState(),
    'fsm_bio_sleeping': new SleepingState(), // Alias mapping to same instance? Or new? 
                                             // Ideally aliases map to same instance key in lookup, 
                                             // but for now unique instances is safer if they have internal name props.
    'fsm_eating': new EatingState(),
    'fsm_bio_eating': new EatingState(),
    'fsm_desperate': new DesperateState(),
    'fsm_survival_desperate': new DesperateState(),

    // --- ECONOMY ---
    'fsm_shopping': new ShoppingState(),
    'fsm_economy_shopping': new ShoppingState(),

    // --- SOCIAL / LEISURE ---
    'fsm_socializing': new SocializingState(),
    'fsm_social_gathering': new SocializingState(),
    'fsm_recreation': new RecreationState(),
    'fsm_leisure_recreation': new RecreationState(),

    // --- MAINTENANCE ---
    'fsm_maintenance': new MaintenanceState(),
    'fsm_maintain_house': new MaintenanceState(),
    'fsm_acquire_housing': new AcquireHousingState(),
    'fsm_maintain_housing_search': new AcquireHousingState(),
    
    // --- TRAVEL ---
    'fsm_commuting': new CommutingState(),
    'fsm_in_transit': new CommutingState(),
    'fsm_travel_commute': new CommutingState(),

    // --- WORK ---
    'fsm_working': new WorkingState(), // Generic
    'fsm_work_office': new WorkingState(),
    'fsm_working_office': new WorkingState(),
    'fsm_work_police': new WorkingState(),
    'fsm_working_police': new WorkingState(),
    'fsm_work_teacher': new WorkingState(),
    'fsm_working_teacher': new WorkingState(),
    'fsm_work_service': new WorkingState(),
    'fsm_working_service': new WorkingState(),

    // --- IDLE ---
    'fsm_idle': new IdleState(),
    'fsm_idle_default': new IdleState(),
    'fsm_idle_homeless': new IdleState(),
    'fsm_homeless': new IdleState(),
};

// Default fallback
const DEFAULT_STATE = STATE_REGISTRY['fsm_idle'];

export class FiniteStateMachine {
    constructor(agent) {
        this.agent = agent;
        this.currentState = null; // Renamed from currentStateInstance
        
        // === NEW: History Tracking ===
        this.stateHistory = []; // Circular buffer for debugging loops
        this.historyLimit = 20;
        this.previousStateName = null;
        this.ticksInCurrentState = 0;
        this.lastTickTimestamp = 0;
        
        // === NEW: Queue for state changes ===
        this.pendingStateChange = null;
        this.pendingStateParams = null;
        this.isTransitioning = false;
        
        // Initialize state context storage on the agent if missing
        if (!this.agent.stateContext) {
            this.agent.stateContext = {};
        }

        this._changeStateInstance(agent.state || 'fsm_idle', { reason: 'init' });
    }

    static clearPathCache() {
        // Placeholder for future path caching
    }

    startInitialState() {
        if (!this.currentState) {
            this._changeStateInstance(this.agent.state || 'fsm_idle', { reason: 'start_initial' });
        }
    }

    /**
     * Primary entry point for changing states.
     * Enforces consistency between the FSM instance and the Agent's data.
     */
    transitionTo(newStateName, params = {}) {
        // Normalize params to ensure reason is tracked
        const finalParams = { reason: 'voluntary', ...params };

        // Guard against recursive state changes
        if (this.isTransitioning) {
            console.warn(`[FSM] Recursive state transition detected (transitioning to ${newStateName}). Queuing change for next tick.`);
            this._queueStateChange(newStateName, finalParams);
            return;
        }

        if (this.currentState && this.currentState.name === newStateName) {
            return; // No-op if already in state
        }
        this._changeStateInstance(newStateName, finalParams);
    }

    // === Intention Stack Management ===
    // Centralizes control over the agent's plans to prevent ownership conflicts

    clearIntentions() {
        this.agent.intentionStack = [];
    }

    pushIntention(intention) {
        if (!this.agent.intentionStack) {
            this.agent.intentionStack = [];
        }
        this.agent.intentionStack.push(intention);
    }

    popIntention() {
        if (this.agent.intentionStack && this.agent.intentionStack.length > 0) {
            return this.agent.intentionStack.pop();
        }
        return null;
    }

    peekIntention() {
        if (this.agent.intentionStack && this.agent.intentionStack.length > 0) {
            return this.agent.intentionStack[this.agent.intentionStack.length - 1];
        }
        return null;
    }

    tick(hour, localEnv, worldState) {
        this.lastTickTimestamp = worldState.currentTick;
        this.ticksInCurrentState++;
        
        let tickResult = { isDirty: false, walOp: null };
        let transitionOccurred = false; // [FIX] Track if transition occurred this tick

        // --- 1. LIZARD BRAIN (Safety Overrides) ---
        if (this._handleCriticalInterruption(worldState.currentTick)) {
            tickResult = { isDirty: true, walOp: null };
        } 
        // --- 2. Execute Normal Tick ---
        else if (this.currentState && typeof this.currentState.tick === 'function') {
            // [REF] Pass THIS.AGENT as the first argument
            tickResult = this.currentState.tick(this.agent, hour, localEnv, worldState);
            
            // NEW: Check if the state wants to transition itself (e.g., activity complete)
            if (tickResult.nextState && tickResult.nextState !== this.agent.state) {
                // Use the transitionTo wrapper for safety and recursion guard
                this.transitionTo(tickResult.nextState, { reason: 'state_self_transition' }); 
                transitionOccurred = true; // [FIX] Mark transition
            }
        }

        // --- 3. Process Pending State Changes ---
        // [FIX] Skip pending state check if already transitioned in step 2 to prevent double-transition
        if (!transitionOccurred && this.pendingStateChange) {
            this._applyPendingState();
        }

        return tickResult;
    }

    /**
     * Checks for emergency biological overrides (The "Lizard Brain").
     * Returns true if an override occurred.
     */
    _handleCriticalInterruption(tick) {
        const agent = this.agent;
        // Use the instance as the source of truth, fall back to agent.state if instance missing (init)
        const state = this.currentState ? this.currentState.name : agent.state;

        // A. PASSING OUT (Energy < CRITICAL_ENERGY_THRESHOLD)
        if ((agent.energy ?? 0) < CRITICAL_ENERGY_THRESHOLD && state !== 'fsm_sleeping') {
            eventBus.emitNow('log:agent', 'high', `[${agent.name}] Collapsed from exhaustion!`);
            eventBus.emitNow('db:writeMemory', 'high', agent.id, tick, `I literally passed out from exhaustion.`);
            
            this.clearIntentions();
            this._queueStateChange('fsm_sleeping', { reason: 'critical_exhaustion' }); 
            return true;
        }

        // B. STARVATION (Hunger > STARVATION_THRESHOLD)
        if ((agent.hunger ?? 0) > STARVATION_THRESHOLD && 
            state !== 'fsm_bio_eating' && 
            state !== 'fsm_desperate' && // [FIX] Check normalized state
            state !== 'fsm_survival_desperate' && // [FIX] Check legacy alias
            state !== 'fsm_economy_shopping') {
            
            eventBus.emitNow('log:agent', 'high', `[${agent.name}] Starving! Entering survival mode.`);
            this._queueStateChange('fsm_desperate', { reason: 'critical_starvation' }); // [FIX] Target standardized state
            return true;
        }
        
        return false;
    }

    _queueStateChange(newStateName, params = {}) {
        this.pendingStateChange = newStateName;
        this.pendingStateParams = params;
    }

    _applyPendingState() {
        if (this.pendingStateChange) {
            this._changeStateInstance(this.pendingStateChange, this.pendingStateParams);
            this.pendingStateChange = null;
            this.pendingStateParams = null;
        }
    }

    _changeStateInstance(newStateName, params = {}) {
        this.isTransitioning = true;
        const reason = params.reason || 'unknown';

        try {
            // Record history before switching
            if (this.currentState) {
                this.stateHistory.push({
                    state: this.currentState.name,
                    duration: this.ticksInCurrentState,
                    exitTick: this.lastTickTimestamp,
                    reason: reason
                });
                
                if (this.stateHistory.length > this.historyLimit) {
                    this.stateHistory.shift();
                }

                // [REF] Pass agent to exit
                this.currentState.exit(this.agent);
                this.previousStateName = this.currentState.name;
                
                // [FIX] Context Persistence
                // Removed blanket wipe `this.agent.stateContext = {}` which was deleting data 
                // intended for the next state and breaking storage for states like Recreation.
                // We now clean up only the previous state's namespace (if it exists).
                if (this.agent.stateContext[this.previousStateName]) {
                    delete this.agent.stateContext[this.previousStateName];
                }
            }
            
            this.ticksInCurrentState = 0;

            // [REF] REGISTRY LOOKUP instead of instantiation
            let nextState = STATE_REGISTRY[newStateName];

            // Fallback if state name is invalid
            if (!nextState) {
                console.warn(`[FSM] Unknown state requested: ${newStateName}. Defaulting to Idle.`);
                nextState = DEFAULT_STATE;
                newStateName = 'fsm_idle';
            }

            this.currentState = nextState;
            
            // Ensure name is synced (though singletons should ideally have fixed names)
            // Note: Since singletons are shared, we can't overwrite this.currentState.name dynamically 
            // if we want to support aliases preserving the alias name. 
            // For now, we trust the registry's instance name or the requested name.
            
            // [REF] Pass agent to enter
            this.currentState.enter(this.agent, params);
            
            // FORCE SYNC: The FSM dictates the agent's state data.
            if (this.agent.state !== newStateName) {
                this.agent.state = newStateName;
            }

        } finally {
            this.isTransitioning = false;
        }
    }
}