import { BaseState } from './BaseState.js';
import { ACTIVITY_COSTS } from '../../data/dataLoader.js';
import { Selector, Sequence, Condition, Action, Inverter, Status } from '../BehaviorTreeCore.js';
import eventBus from '../eventBus.js';
import worldGraph from '../../data/worldGraph.js';

// === 1. LEAF NODES ===

const Actions = {
    AbortMaintenance: (agent, { reason }) => {
        if (agent.lod === 1) console.log(`[${agent.name}] Stopping maintenance: ${reason}`);
        if (reason.includes("afford")) {
             eventBus.emitNow('db:writeMemory', 'medium', agent.id, agent.matrix?.tickCount, "Cannot afford to fix up my place.");
        }
        return { isDirty: true, nextState: 'fsm_idle' };
    },

    RepairHome: (agent, { worldState }) => {
        const homeNode = worldGraph.nodes[agent.homeLocationId];
        const baseCost = (ACTIVITY_COSTS['maintenance'] || 5); 

        // Skill logic
        const skillLevel = (agent.skills?.maintenance ?? 0) / 100;
        const diligence = agent.persona?.conscientiousness ?? 0.5;
        
        let repairAmount = 2 + (skillLevel * 2);
        let costEfficiency = Math.max(0.5, 1.0 - (skillLevel * 0.5));
        
        const actualCost = baseCost * costEfficiency;

        // Transaction
        agent.money = (agent.money ?? 0) - actualCost;
        homeNode.condition = Math.min(100, (homeNode.condition ?? 100) + repairAmount);
        
        // Stats
        agent.mood = Math.min(100, (agent.mood ?? 0) + (diligence > 0.6 ? 0.5 : 0.1));
        agent.stress = Math.max(0, (agent.stress ?? 0) - (diligence > 0.4 ? 0.5 : -0.1));

        // Flavor Event (5%)
        if (Math.random() < 0.05) {
             eventBus.emitNow('db:writeMemory', 'low', agent.id, worldState.currentTick, "Fixed something around the house.");
        }
        
        return { 
            isDirty: true, 
            walOp: { op: 'AGENT_MAINTAIN_HOME', data: { cost: actualCost, newCondition: homeNode.condition } } 
        };
    }
};

const Conditions = {
    HasHome: (agent) => !!agent.homeLocationId && !!worldGraph.nodes[agent.homeLocationId],
    
    IsSpotless: (agent) => {
        const node = worldGraph.nodes[agent.homeLocationId];
        return node && node.condition >= 100;
    },

    CanAfford: (agent) => {
        const baseCost = (ACTIVITY_COSTS['maintenance'] || 5); 
        // Estimate efficiency based on skill roughly to avoid soft lock if barely affordable
        // But safer to check base cost to be conservative
        return (agent.money ?? 0) >= baseCost;
    }
};

// === 2. BEHAVIOR TREE ===

const MaintenanceTree = new Selector([
    // 1. Validate
    new Sequence([
        new Inverter(new Condition(Conditions.HasHome)),
        new Action((a) => Actions.AbortMaintenance(a, { reason: "No Home" }))
    ]),

    // 2. Completion Check
    new Sequence([
        new Condition(Conditions.IsSpotless),
        new Action((a) => Actions.AbortMaintenance(a, { reason: "Home is clean" }))
    ]),

    // 3. Budget Check (Check before ANY work happens)
    new Sequence([
        new Inverter(new Condition(Conditions.CanAfford)),
        new Action((a) => Actions.AbortMaintenance(a, { reason: "Cannot afford supplies" }))
    ]),

    // 4. Do Work (Only reaches here if CanAfford passed)
    new Sequence([
        new Condition(Conditions.CanAfford), // Double check right before transaction for safety in reactive tree
        new Action(Actions.RepairHome)
    ]),
    
    // Fallback if somehow Afford passed but then failed (rare race condition), abort
    new Action((a) => Actions.AbortMaintenance(a, { reason: "Budget inconsistency" }))
]);

// === 3. STATE CLASS ===

export class MaintenanceState extends BaseState {
    enter(agent) {
        super.enter(agent);
        this._updateActivityFromState(agent);
    }

    tick(agent, hour, localEnv, worldState) {
        super.tick(agent, hour, localEnv, worldState);

        const context = { hour, localEnv, worldState, transition: null };
        const status = MaintenanceTree.execute(agent, context);

        if (context.transition) return context.transition;

        // Perform less frequent UI updates for maintenance
        return { isDirty: (worldState.currentTick % 10 === 0), walOp: context.walOp };
    }
}