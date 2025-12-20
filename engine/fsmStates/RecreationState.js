import { BaseState } from './BaseState.js';
import { STRESS_REDUCTION_PER_TICK_FIXED } from '../fsm.js';
import { ACTIVITIES_MAP } from '../../data/dataLoader.js';
import { GAME_BALANCE } from '../../data/balance.js';
import { isAgentWorkShift } from '../agentUtilities.js';
import eventBus from '../eventBus.js';

export class RecreationState extends BaseState {
    
    // [REF] Removed constructor(fsm, goal)

    // [REF] Added agent param
    enter(agent, params = {}) {
        super.enter(agent);
        this._updateActivityFromState(agent);
        this.log(`[${agent.name}] Starting recreation: ${agent.currentActivityName}.`);
        
        // [REF] Move stateful properties to agent.stateContext
        // We look at the params passed to transitionTo/enter, OR the intention stack context
        // The FSM passes params to enter() now.
        agent.stateContext.duration = params.context?.duration || null;
        agent.stateContext.ticksInState = 0; 
    }

    // [REF] Added agent param
    tick(agent, hour, localEnv, worldState) {
        // 1. Curfew Check (Hard Stop)
        if (hour >= 2 && hour < 5) {
            this.log(`[${agent.name}] It's way too late (Curfew). Stopping recreation.`);
            this._exitRecreation(agent, 'It got too late.');
            return { isDirty: true, walOp: { op: 'AGENT_STATE_UPDATE', data: { state: 'fsm_idle' } }, nextState: 'fsm_idle' };
        }

        // 2. Work Shift Check
        if (isAgentWorkShift(agent, hour)) {
             this.log(`[${agent.name}] Work shift started. Stopping recreation.`);
             this._exitRecreation(agent, 'Work shift started.');
             return { isDirty: true, walOp: { op: 'AGENT_STATE_UPDATE', data: { state: 'fsm_idle' } }, nextState: 'fsm_idle' };
        }

        agent.stateContext.ticksInState++;
        if (agent.stateContext.duration !== null && agent.stateContext.ticksInState >= agent.stateContext.duration) {
            this._exitRecreation(agent, 'Planned duration ended.');
            return { isDirty: true, walOp: { op: 'AGENT_STATE_UPDATE', data: { state: 'fsm_idle' } }, nextState: 'fsm_idle' };
        }

        super.tick(agent, hour, localEnv, worldState, { skipStressCalculation: true });

        const currentActDef = ACTIVITIES_MAP[agent.currentActivityName] || {};
        const tags = currentActDef.interest_tags || [];
        const isActive = tags.includes('active') || tags.includes('creative');
        
        let stressReduction = STRESS_REDUCTION_PER_TICK_FIXED; 
        let boredomReduction = 10;
        let energyCost = 0;

        const openness = agent.persona?.openness ?? 0.5;
        const extroversion = agent.persona?.extroversion ?? 0.5;

        if (isActive) {
            stressReduction *= 2.5; 
            boredomReduction = 15 * (openness > 0.6 ? 0.8 : 1.0); 
            energyCost = 2.0;       
        } else {
            stressReduction *= 1.0; 
            boredomReduction = 8 * (openness > 0.7 ? 1.5 : 1.0);
            energyCost = 0; 
        }

        const crowdCount = agent.perceivedAgents?.length || 0;
        if (extroversion < 0.4 && (localEnv.noise ?? 0) < 0.3) {
            stressReduction += 1.0; 
        } else if (extroversion > 0.6 && crowdCount > 2) {
            stressReduction += 0.5;
            agent.social = Math.min(100, (agent.social ?? 0) + 0.2); 
        }

        if ((localEnv.condition ?? 100) < 40) {
            stressReduction *= 0.5;
        }

        agent.boredom = Math.max(0, (agent.boredom ?? 0) - boredomReduction); 
        agent.stress = Math.max(0, (agent.stress ?? 0) - stressReduction);
        agent.energy = Math.max(0, Math.min(100, (agent.energy ?? 100) - energyCost)); 
        agent.mood = Math.min(100, (agent.mood ?? 0) + GAME_BALANCE.REGEN.MOOD_BOOST_RECREATION);

        // Flavor Events
        if (Math.random() < 0.01) {
            const events = [
                "lost track of time completely",
                "felt a wave of calm",
                "had a great idea",
                "really enjoyed the atmosphere",
                "felt like myself again"
            ];
            const evt = events[Math.floor(Math.random() * events.length)];
            eventBus.emitNow('db:writeMemory', 'low', agent.id, worldState.currentTick, `While relaxing, I ${evt}.`);
            agent.mood = Math.min(100, (agent.mood ?? 0) + 5);
        }

        // Natural Exit Conditions
        if ((agent.boredom ?? 0) <= 5 && (agent.stress ?? 0) <= 10) {
            this.log(`[${agent.name}] Feeling refreshed. Stopping recreation.`);
            this._exitRecreation(agent, 'Fully refreshed.');
            return { isDirty: true, walOp: { op: 'AGENT_STATE_UPDATE', data: { state: 'fsm_idle' } }, nextState: 'fsm_idle' };
        } else if (isActive && (agent.energy ?? 100) < 10) {
            this.log(`[${agent.name}] Too tired to continue ${agent.currentActivityName}.`);
            this._exitRecreation(agent, 'Too tired.');
            return { isDirty: true, walOp: { op: 'AGENT_STATE_UPDATE', data: { state: 'fsm_idle' } }, nextState: 'fsm_idle' };
        }
        
        return { isDirty: (worldState.currentTick % 10 === 0), walOp: null };
    }

    // [REF] Added agent param
    _exitRecreation(agent, reason) {
        if (agent.intentionStack) agent.intentionStack.pop();
        // Return handled by caller, or caller uses nextState
    }
}