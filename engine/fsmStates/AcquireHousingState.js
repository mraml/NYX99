import { BaseState } from './BaseState.js';
import { GAME_BALANCE } from '../../data/balance.js';
import worldGraph from '../../data/worldGraph.js';

export class AcquireHousingState extends BaseState {
    
    // [REF] Added agent param
    enter(agent) {
        super.enter(agent);
        // [REF] Use stateContext instead of this.displayName if it needs to be dynamic
        // But since this is specific to this state, we can assume updateActivity uses a constant.
        // However, updateActivityFromState reads this.displayName. 
        // We need to set it on the instance ONLY if we are okay with it being shared... 
        // WAIT. 'displayName' on BaseState was used to override activity name.
        // Since singletons are shared, we CANNOT set this.displayName = 'Searching...' here.
        // We must override _updateActivityFromState or set it on context.
        
        // Solution: Set it on the context, and update BaseState to read from context?
        // OR: Just set agent.currentActivity directly here.
        agent.currentActivity = 'Searching for New Home';
    }

    // [REF] Added agent param
    tick(agent, hour, localEnv, worldState) {
        // [REF] Passed agent
        super.tick(agent, hour, localEnv, worldState, { decay: true, regen: false, stress: false });
        
        // --- 1. SAFETY / UTILITY CHECK ---
        const cost = GAME_BALANCE.COSTS?.HOUSING_DOWNPAYMENT || 1000;
        
        // --- 1a. SMARTER COOLDOWN CHECK ---
        const lastFail = agent.lastHousingFailureTick || 0;
        const ticksSinceFailure = worldState.currentTick - lastFail;
        
        if (ticksSinceFailure < 24 && (agent.money ?? 0) < cost) {
             this.log(`[${agent.name}] Recently failed and still cannot afford housing. Waiting.`);
             return { isDirty: true, nextState: 'fsm_idle' };
        }
        
        // --- 2. CANNOT AFFORD CHECK (Final decision) ---
        if ((agent.money ?? 0) < cost) {
            this.log(`[${agent.name}] Cannot afford housing ($${agent.money}/${cost}). Giving up for now.`);
            
            agent.lastHousingFailureTick = worldState.currentTick;
            
            const next = (agent.money < 100) ? 'fsm_working' : 'fsm_idle';
            
            return { isDirty: true, nextState: next };
        }

        // --- 3. TRAVEL CHECK ---
        const currentLoc = agent.locationId || agent.homeLocationId;
        if (currentLoc !== agent.targetLocationId) {
            this.log(`[${agent.name}] Need to travel to housing location first.`);
            // Transition to the standard travel state
            return { isDirty: true, nextState: 'fsm_commuting' };
        }

        // --- 4. EXECUTION ---
        const newHomeNode = worldGraph.nodes[agent.targetLocationId];
        if (newHomeNode && newHomeNode.type === 'home') {
            agent.money -= cost;
            agent.homeLocationId = newHomeNode.key;
            agent.homeNode = newHomeNode;
            agent.rent_cost = newHomeNode.rent_cost;
            agent.lastHousingFailureTick = 0; 
            
            this.log(`[${agent.name}] Acquired home at ${newHomeNode.name}!`, 'high', true, worldState.currentTick);
            
            return { 
                isDirty: true, 
                walOp: { op: 'AGENT_ACQUIRED_HOME', data: { cost, newHomeId: newHomeNode.key } },
                nextState: 'fsm_idle'
            };
        }

        return { isDirty: true, nextState: 'fsm_idle' };
    }
}