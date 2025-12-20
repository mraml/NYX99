import { BaseState } from './BaseState.js';
import { GAME_BALANCE } from '../../data/balance.js';
import worldGraph from '../../data/worldGraph.js';

/**
 * DesperateState.js
 * Fallback state for agents with critical needs and no resources.
 * [REF] Stateless Flyweight Version
 */
export class DesperateState extends BaseState {
    
    // [REF] Added agent param
    enter(agent) {
        super.enter(agent);
        this._updateActivityFromState(agent);
        this.log(`[${agent.name}] Is desperate! No money, no food.`);
        
        // [REF] Move stateful properties to agent.stateContext
        agent.stateContext.ticksInState = 0;
        agent.stateContext.maxDesperationTicks = 120; // Hard cap (2 hours)
    }

    // [REF] Added agent param
    tick(agent, hour, localEnv, worldState) {
        super.tick(agent, hour, localEnv, worldState);
        agent.stateContext.ticksInState++;

        let isDirty = true;
        let walOp = null;

        // Hard Loop Break
        if (agent.stateContext.ticksInState >= agent.stateContext.maxDesperationTicks) {
             this.log(`[${agent.name}] Too exhausted to scrounge. Resting.`);
             return { isDirty: true, walOp: { op: 'AGENT_STATE_UPDATE', data: { state: 'fsm_idle' } }, nextState: 'fsm_idle' };
        }

        // 1. BEGGING / SCAVENGING LOGIC
        if (Math.random() < 0.1) {
            const foundMoney = Math.floor(Math.random() * 5) + 1;
            agent.money = (agent.money ?? 0) + foundMoney;
            this.log(`[${agent.name}] Scrounged up $${foundMoney}.`);
            walOp = { op: 'AGENT_FOUND_MONEY', data: { amount: foundMoney } };
        }

        // 2. RECOVERY CONDITION
        const foodCost = GAME_BALANCE.COSTS?.GROCERIES || 20; 
        if ((agent.money ?? 0) >= foodCost) {
            this.log(`[${agent.name}] Scraped together enough cash ($${agent.money}). Heading to store.`);
            return { isDirty: true, walOp, nextState: 'fsm_shopping' };
        }

        // 3. MOVEMENT (Wander to find better spots)
        if (agent.stateContext.ticksInState % 20 === 0) {
            const target = worldGraph.findRandomLocationByType('park') || worldGraph.findRandomLocationByType('subway_station');
            if (target && target.key !== agent.locationId) {
                agent.targetLocationId = target.key;
                return { isDirty: true, walOp, nextState: 'fsm_commuting' };
            }
        }

        agent.stress = Math.min(100, (agent.stress ?? 0) + 0.5);
        agent.mood = Math.max(-100, (agent.mood ?? 0) - 0.5);

        return { isDirty, walOp };
    }
}