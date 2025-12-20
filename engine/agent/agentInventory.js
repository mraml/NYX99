import { ITEM_CATALOG } from '../../data/dataLoader.js'; 

/**
 * agent/agentInventory.js
 * Provides utility functions for managing an Agent's inventory.
 * * IMPROVEMENTS v2.0:
 * - Added Spoilage System (Food rots over time).
 * - Added Inventory Capacity (Slot limits).
 * - Added Shopping Heuristics (Smart logic for what to buy).
 */

const INVENTORY_CAPACITY = 10; // Max items an agent can carry
const DEFAULT_SHELF_LIFE = 24 * 7; // Approx 1 week in game hours (assuming 1 tick = 1 hour)

// --- 1999 INVENTORY GENERATOR ---
export function createInitialInventory(jobTitle, startingMoney, currentTick = 0) {
    const inventory = [];
    
    // 1. Basics (Food) - Added timestamp for spoilage
    const foodItem = ITEM_CATALOG['canned_soup'] || { id: 'generic_food', uses: 5, type: 'food', name: 'Food Rations', shelf_life: 168 };
    inventory.push({ 
        itemId: foodItem.id, 
        usesLeft: foodItem.uses, 
        type: foodItem.type,
        acquiredTick: currentTick 
    });

    // 2. Tech (The 1999 Digital Divide)
    const title = (jobTitle || '').toLowerCase();
    const isHighStatus = title.includes('doctor') || title.includes('executive') || 
                         title.includes('lawyer') || title.includes('manager') || 
                         title.includes('dealer');
    
    // Nokia 3210 cost roughly $200-$400 equivalent
    if (isHighStatus || startingMoney > 2000) {
        inventory.push({ itemId: 'cell_phone', name: 'Nokia 3210', type: 'tech', acquiredTick: currentTick });
    } else {
        inventory.push({ itemId: 'pager', name: 'Beeper', type: 'tech', acquiredTick: currentTick });
    }

    return inventory;
}

/**
 * Finds the first consumable food item that isn't spoiled.
 */
export function getConsumableFoodItem(agent) {
    return (agent.inventory ?? []).find(item => 
        item.type === 'food' && 
        (item.usesLeft === undefined || item.usesLeft > 0) &&
        !item.isSpoiled // Don't eat rotten food
    );
}

/**
 * Checks for specific item ownership
 */
export function hasItem(agent, itemId) {
    return (agent.inventory ?? []).some(item => item.itemId === itemId);
}

/**
 * Checks if the agent has space for more items.
 */
export function canAddItem(agent) {
    return (agent.inventory ?? []).length < INVENTORY_CAPACITY;
}

/**
 * Adds an item to inventory if space allows.
 * @returns {boolean} True if added, False if full.
 */
export function addItem(agent, itemId, currentTick = 0) {
    if (!canAddItem(agent)) return false;
    
    const def = ITEM_CATALOG[itemId];
    if (!def) return false;

    if (!agent.inventory) agent.inventory = [];
    
    agent.inventory.push({
        itemId: itemId,
        name: def.name,
        type: def.type,
        usesLeft: def.uses,
        acquiredTick: currentTick,
        isSpoiled: false
    });
    return true;
}

/**
 * Removes a consumed item or decrements uses.
 */
export function consumeItem(agent, itemId) {
    const index = (agent.inventory ?? []).findIndex(item => item.itemId === itemId && (item.usesLeft === undefined || item.usesLeft > 0));
    
    if (index === -1) return;

    let itemInstance = agent.inventory[index];
    const itemDefinition = ITEM_CATALOG[itemInstance.itemId];

    if (itemDefinition && (itemDefinition.uses === Infinity || itemDefinition.type === 'tool')) {
        if (itemInstance.usesLeft > 0) {
            itemInstance.usesLeft--;
        }
    } else {
        agent.inventory.splice(index, 1);
    }
}

/**
 * Checks for items matching a skill tag (e.g. 'programming' book).
 */
export function hasHobbyItem(agent, skillTag) {
    return (agent.inventory ?? []).find(item => {
        const definition = ITEM_CATALOG[item.itemId];
        return definition?.skill_mod === skillTag;
    });
}

/**
 * MAINTENANCE: Check for spoiled food.
 * Should be called periodically (e.g. once a day).
 */
export function checkSpoilage(agent, currentTick) {
    let spoiledCount = 0;
    (agent.inventory ?? []).forEach(item => {
        if (item.type === 'food' && !item.isSpoiled) {
            const def = ITEM_CATALOG[item.itemId];
            const shelfLife = def?.shelf_life || DEFAULT_SHELF_LIFE;
            const age = currentTick - (item.acquiredTick || 0);
            
            if (age > shelfLife) {
                item.isSpoiled = true;
                item.name = `Rotten ${item.name}`;
                spoiledCount++;
            }
        }
    });
    return spoiledCount;
}

/**
 * INTELLIGENCE: Generate a shopping list based on needs and budget.
 * Used by ShoppingState to decide what to buy.
 */
export function getShoppingNeeds(agent) {
    const needs = [];
    const inventory = agent.inventory ?? [];
    
    // 1. Food Security (Buy if less than 2 food items)
    const foodCount = inventory.filter(i => i.type === 'food' && !i.isSpoiled).length;
    if (foodCount < 2) {
        needs.push('groceries'); // Generic ID, resolved by store logic
    }

    // 2. Tech Upgrade (Buy Cell Phone if rich but using Pager)
    const hasCell = hasItem(agent, 'cell_phone');
    if (!hasCell && agent.money > 1000) {
        needs.push('cell_phone');
    }

    // 3. Stress Management (Buy relaxation items if stressed)
    if ((agent.stress ?? 0) > 60) {
        if (!hasHobbyItem(agent, 'relaxation')) {
            needs.push('magazine'); // or cigarettes, etc.
        }
    }

    return needs;
}