import { BaseState } from './BaseState.js';
import { ACTIVITY_COSTS, ITEM_CATALOG } from '../../data/dataLoader.js';
import { Selector, Sequence, Condition, Action, Inverter, Status } from '../BehaviorTreeCore.js';
import eventBus from '../eventBus.js';
import worldGraph from '../../data/worldGraph.js'; 

// === 1. LEAF NODES (LOGIC) ===

const Actions = {
    // Determine what we want to buy and how much we are willing to pay
    EvaluateBudget: (agent, context) => {
        // Only run this once per shopping trip to ensure consistency
        if (agent.stateContext.plan) return Status.SUCCESS;

        const baseCost = ACTIVITY_COSTS['shopping'] || 10;
        const conscientiousness = agent.persona?.conscientiousness ?? 0.5;
        const stress = agent.stress ?? 0;
        
        let multiplier = 1.0;
        let strategy = 'standard';
        let itemType = 'protein_bar'; // Default

        // Retail Therapy / Impulse Buying
        if (stress > 60 || conscientiousness < 0.3) {
            multiplier = 1.5; 
            strategy = 'impulse';
            itemType = 'energy_drink'; // Or random premium item
        } 
        // Frugal Shopping
        else if (conscientiousness > 0.7) {
            multiplier = 0.8; 
            strategy = 'frugal';
            itemType = 'canned_soup';
        }

        agent.stateContext.plan = {
            totalCost: baseCost * multiplier,
            strategy: strategy,
            itemType: itemType,
            itemCount: 5
        };
        
        return Status.SUCCESS;
    },

    // Try to actually buy the items
    AttemptTransaction: (agent, context) => {
        const plan = agent.stateContext.plan;
        const loc = worldGraph.nodes[agent.locationId];

        if (!loc) return Status.FAILURE;

        // CRITICAL: Check stock first
        // Note: consumeStock returns true if successful. 
        // We use it here because it's atomic. If it returns true, we MUST pay.
        if (worldGraph.consumeStock(loc.key)) {
            // Deduct Money
            agent.money = (agent.money ?? 0) - plan.totalCost;
            
            // Add Inventory
            const itemDef = ITEM_CATALOG[plan.itemType] || { id: 'food', uses: 5, type: 'food' };
            if (!Array.isArray(agent.inventory)) agent.inventory = [];
            
            for (let i = 0; i < plan.itemCount; i++) {
                agent.inventory.push({ 
                    itemId: itemDef.id, 
                    usesLeft: itemDef.uses, 
                    type: itemDef.type 
                });
            }

            // Log Transaction
            return { 
                isDirty: true, 
                walOp: { 
                    op: 'AGENT_BUY_FOOD', 
                    data: { 
                        cost: plan.totalCost, 
                        itemsBought: plan.itemCount, 
                        itemId: itemDef.id 
                    } 
                } 
            };
        } else {
            return Status.FAILURE; // Out of stock
        }
    },

    // Success outcomes
    HandleSuccess: (agent, context) => {
        const strategy = agent.stateContext.plan.strategy;
        
        if (strategy === 'impulse') {
            agent.mood = Math.min(100, (agent.mood ?? 0) + 5);
            agent.stress = Math.max(0, (agent.stress ?? 0) - 5);
            eventBus.emitNow('db:writeMemory', 'low', agent.id, context.worldState.currentTick, `Splurged on groceries. I deserved a treat.`);
        } else if (strategy === 'frugal') {
            agent.mood = Math.min(100, (agent.mood ?? 0) + 2);
        }

        // 10% Chance of flavor event
        if (Math.random() < 0.1) {
            const events = [
                "found a free sample",
                "ran into a neighbor",
                "liked the music in the store"
            ];
            const evt = events[Math.floor(Math.random() * events.length)];
            eventBus.emitNow('db:writeMemory', 'low', agent.id, context.worldState.currentTick, `At the store, I ${evt}.`);
        }

        return Status.SUCCESS;
    },

    // Failure outcomes
    HandlePoverty: (agent) => {
        agent.stress = Math.min(100, (agent.stress ?? 0) + 10);
        agent.mood = Math.max(0, (agent.mood ?? 0) - 10);
        return { isDirty: true, walOp: { op: 'AGENT_LOG', data: { msg: "Card declined. Embarrassing." } } };
    },

    HandleNoStock: (agent) => {
        return { isDirty: true, walOp: { op: 'AGENT_LOG', data: { msg: "Store was out of stock." } } };
    },

    LeaveShop: (agent) => {
        if (agent.intentionStack) agent.intentionStack.pop();
        return { isDirty: true, nextState: 'fsm_idle' };
    }
};

const Conditions = {
    CanAfford: (agent) => {
        const cost = agent.stateContext.plan?.totalCost || 9999;
        return (agent.money ?? 0) >= cost;
    }
};

// === 2. BEHAVIOR TREE ===

const ShoppingTree = new Sequence([
    // Step 1: Make a plan (Budgeting)
    new Action(Actions.EvaluateBudget),

    // Step 2: Try to execute the plan
    new Selector([
        // Option A: Successful Purchase
        new Sequence([
            new Condition(Conditions.CanAfford),
            new Action(Actions.AttemptTransaction), // Returns FAILURE if Out of Stock
            new Action(Actions.HandleSuccess),
            new Action(Actions.LeaveShop)
        ]),
        
        // Option B: Failed (Too Poor)
        new Sequence([
            new Inverter(new Condition(Conditions.CanAfford)),
            new Action(Actions.HandlePoverty),
            new Action(Actions.LeaveShop)
        ]),

        // Option C: Failed (Out of Stock) -> Fallback if AttemptTransaction fails
        new Sequence([
            new Action(Actions.HandleNoStock),
            new Action(Actions.LeaveShop)
        ])
    ])
]);

// === 3. STATE CLASS ===

export class ShoppingState extends BaseState {
    enter(agent) {
        super.enter(agent);
        this._updateActivityFromState(agent);
        agent.stateContext.plan = null; // Reset plan
        if (agent.lod === 1) this.log(`[${agent.name}] Entered store.`);
    }

    tick(agent, hour, localEnv, worldState) {
        super.tick(agent, hour, localEnv, worldState); 

        const context = { hour, localEnv, worldState, transition: null };
        const status = ShoppingTree.execute(agent, context);

        if (context.transition) {
            return context.transition;
        }

        return { isDirty: (worldState.currentTick % 5 === 0), walOp: null };
    }
}