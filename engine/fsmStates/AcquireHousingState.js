import { BaseState } from './BaseState.js';
import { Selector, Sequence, Condition, Action, Inverter, Status } from '../BehaviorTreeCore.js';
import { GAME_BALANCE } from '../../data/balance.js';
import worldGraph from '../../data/worldGraph.js';

// === 1. LEAF NODES ===

const Actions = {
    // NEW: Find a target if we don't have one
    FindHousingTarget: (agent) => {
        if (agent.targetLocationId) return Status.SUCCESS;

        // Try to find a 'home' node that isn't the current one (if any)
        // In a real sim, we'd check for vacancies. For now, random 'home' node.
        const potentialHome = worldGraph.findRandomLocationByType('home');
        
        if (potentialHome) {
            agent.targetLocationId = potentialHome.key;
            if (agent.lod === 1) console.log(`[${agent.name}] Found potential home at ${agent.targetLocationId}`);
            return Status.SUCCESS;
        }
        
        // If no homes found, fail gracefully
        if (agent.lod === 1) console.log(`[${agent.name}] No housing available in world.`);
        return { isDirty: true, nextState: 'fsm_idle' }; 
    },

    GiveUpHousing: (agent, { worldState }) => {
        agent.lastHousingFailureTick = worldState.currentTick;
        if (agent.lod === 1) console.log(`[${agent.name}] Cannot afford housing. Giving up.`);
        
        // Decide next step based on desperation
        const next = (agent.money < 100) ? 'fsm_working' : 'fsm_idle';
        return { isDirty: true, nextState: next };
    },

    TravelToHouse: (agent) => {
        if (agent.lod === 1) console.log(`[${agent.name}] Traveling to potential home.`);
        return { isDirty: true, nextState: 'fsm_commuting' };
    },

    SignLease: (agent, { worldState }) => {
        const cost = GAME_BALANCE.COSTS?.HOUSING_DOWNPAYMENT || 1000;
        const newHomeNode = worldGraph.nodes[agent.targetLocationId];
        
        if (newHomeNode && newHomeNode.type === 'home') {
            agent.money -= cost;
            agent.homeLocationId = newHomeNode.key;
            agent.homeNode = newHomeNode; // Note: This might not serialize well, ID is better
            agent.rent_cost = newHomeNode.rent_cost;
            agent.lastHousingFailureTick = 0;
            
            return { 
                isDirty: true, 
                walOp: { op: 'AGENT_ACQUIRED_HOME', data: { cost, newHomeId: newHomeNode.key } },
                nextState: 'fsm_idle'
            };
        }
        return { isDirty: true, nextState: 'fsm_idle' }; // Failed logic
    },
    
    WaitCooldown: (agent) => {
        // Just idle/wait if we recently failed but are still here
        return { isDirty: true, nextState: 'fsm_idle' };
    }
};

const Conditions = {
    CanAfford: (agent) => {
        const cost = GAME_BALANCE.COSTS?.HOUSING_DOWNPAYMENT || 1000;
        return (agent.money ?? 0) >= cost;
    },
    
    IsCoolingDown: (agent, { worldState }) => {
        const lastFail = agent.lastHousingFailureTick || 0;
        return (worldState.currentTick - lastFail) < 24;
    },

    IsAtTarget: (agent) => {
        const currentLoc = agent.locationId || agent.homeLocationId;
        return currentLoc === agent.targetLocationId;
    }
};

// === 2. BEHAVIOR TREE ===

const HousingTree = new Selector([
    // 1. Cooldown Check (Don't spam searches if broke)
    new Sequence([
        new Condition(Conditions.IsCoolingDown),
        new Inverter(new Condition(Conditions.CanAfford)), // If broke AND cooling down
        new Action(Actions.WaitCooldown)
    ]),

    // 2. Affordability Check (Hard Gate)
    new Sequence([
        new Inverter(new Condition(Conditions.CanAfford)),
        new Action(Actions.GiveUpHousing)
    ]),

    // 3. Identification (Find a target)
    new Action(Actions.FindHousingTarget),

    // 4. Travel Check
    new Sequence([
        new Inverter(new Condition(Conditions.IsAtTarget)),
        new Action(Actions.TravelToHouse)
    ]),

    // 5. Execution
    new Action(Actions.SignLease)
]);

// === 3. STATE CLASS ===

export class AcquireHousingState extends BaseState {
    enter(agent) {
        super.enter(agent);
        agent.currentActivity = 'Searching for New Home';
        // Ensure target is clear on entry so we find a new one
        agent.targetLocationId = null;
    }

    tick(agent, hour, localEnv, worldState) {
        super.tick(agent, hour, localEnv, worldState, { decay: true });

        const context = { hour, localEnv, worldState, transition: null };
        const status = HousingTree.execute(agent, context);

        if (context.transition) return context.transition;

        return { isDirty: true, walOp: context.walOp };
    }
}