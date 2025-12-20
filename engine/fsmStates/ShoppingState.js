import { BaseState } from './BaseState.js';
import { ACTIVITY_COSTS, ITEM_CATALOG } from '../../data/dataLoader.js';
import { GAME_BALANCE } from '../../data/balance.js';
import eventBus from '../eventBus.js';
import worldGraph from '../../data/worldGraph.js'; 

/**
 * ShoppingState.js
 * Handles the transactional logic for 'fsm_shopping'.
 * [REF] Stateless Flyweight Version
 */
export class ShoppingState extends BaseState {
    
    // [REF] Added agent param
    enter(agent) {
        super.enter(agent);
        this._updateActivityFromState(agent);
        if (agent.lod === 1) {
            this.log(`[${agent.name}] Heading to the store.`);
        }
    }

    // [REF] Added agent param
    tick(agent, hour, localEnv, worldState) {
        super.tick(agent, hour, localEnv, worldState);

        let isDirty = true;
        let walOp = null;
        
        // Base Cost
        let cost = ACTIVITY_COSTS['shopping'] || 10;
        const ITEMS_TO_BUY = 5;
        
        const loc = worldGraph.nodes[agent.locationId];

        // --- 1. Personality & Stress (The "Shopper" Factor) ---
        const conscientiousness = agent.persona?.conscientiousness ?? 0.5;
        const stress = agent.stress ?? 0;
        
        let impulseBuy = false;
        let bargainHunt = false;

        // Retail Therapy / Impulse Buying
        if (stress > 60 || conscientiousness < 0.3) {
            cost *= 1.5; // 50% Markup for premium/junk food
            impulseBuy = true;
        } 
        // Frugal Shopping
        else if (conscientiousness > 0.7) {
            cost *= 0.8; // 20% Discount
            bargainHunt = true;
        }

        if (loc && worldGraph.consumeStock(loc.key)) {
            // Store has stock
            if ((agent.money ?? 0) >= cost) {
                agent.money = (agent.money ?? 0) - cost;

                // --- 2. Inventory Logic ---
                // Determine item quality based on shopper behavior
                let itemKey = 'canned_soup'; // default
                
                if (impulseBuy && ITEM_CATALOG['energy_drink']) itemKey = 'energy_drink';
                else if (bargainHunt && ITEM_CATALOG['canned_soup']) itemKey = 'canned_soup';
                else if (ITEM_CATALOG['protein_bar']) itemKey = 'protein_bar';
                
                const itemDef = ITEM_CATALOG[itemKey] || { id: 'food', uses: 5, type: 'food', name: 'Groceries' };

                if (!Array.isArray(agent.inventory)) agent.inventory = [];

                for (let i = 0; i < ITEMS_TO_BUY; i++) {
                    agent.inventory.push({ 
                        itemId: itemDef.id, 
                        usesLeft: itemDef.uses, 
                        type: itemDef.type 
                    });
                }
                
                // --- 3. Emotional Payoff ---
                if (impulseBuy) {
                    agent.mood = Math.min(100, (agent.mood ?? 0) + 5);
                    agent.stress = Math.max(0, (agent.stress ?? 0) - 5);
                    if (agent.lod === 1) this.log(`[${agent.name}] Impulse bought some treats. Needed that.`);
                    
                    eventBus.emitNow('db:writeMemory', 'low', agent.id, worldState.currentTick, `Splurged on groceries. I deserved a treat.`);
                } else if (bargainHunt) {
                    agent.mood = Math.min(100, (agent.mood ?? 0) + 2);
                    if (agent.lod === 1) this.log(`[${agent.name}] Used coupons to save money.`);
                }

                walOp = { op: 'AGENT_BUY_FOOD', data: { cost: cost, itemsBought: ITEMS_TO_BUY, itemId: itemDef.id } };
                
                // --- 4. Flavor Events ---
                if (Math.random() < 0.1) {
                    const events = [
                        "got into an argument over the last carton of milk",
                        "ran into an old acquaintance",
                        "slipped on a wet floor",
                        "found a free sample station",
                        "realized the music playing is my jam"
                    ];
                    const evt = events[Math.floor(Math.random() * events.length)];
                    eventBus.emitNow('db:writeMemory', 'low', agent.id, worldState.currentTick, `At the store, I ${evt}.`);
                }

            } else {
                // Failure: Broke
                agent.stress = Math.min(100, (agent.stress ?? 0) + 10);
                agent.mood = Math.max(0, (agent.mood ?? 0) - 10);
                
                this.log(`[${agent.name}] Card declined. Can't afford groceries ($${cost.toFixed(2)}).`);
                eventBus.emitNow('db:writeMemory', 'high', agent.id, worldState.currentTick, `Tried to buy food but my card was declined. This is humiliating.`);
            }
        } else {
            // Failure: Out of Stock
            this.log(`[${agent.name}] Store is out of stock. Leaving frustrated.`);
        }
        
        return { isDirty, walOp, nextState: 'fsm_idle' };
    }
}