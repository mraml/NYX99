import { dataLoader } from '../data/dataLoader.js';

/**
 * worldSeeder.js
 * "Hydrates" the raw spatial graph with semantic richness (Economy, Culture, Physics).
 * This runs once on server start to turn "manhattan_0" into "The Overlook Apartments".
 */

// --- Configuration: Neighborhood Bounding Boxes (0-21 scale based on your graph) ---
// Approximate mapping of the grid to NYC geography
const BOROUGHS = {
    manhattan: {
        districts: [
            { id: 'financial_district', yMax: 2 },
            { id: 'soho', yMax: 4 },
            { id: 'hells_kitchen', yMax: 8 },
            { id: 'upper_west_side', yMax: 12 },
            { id: 'harlem', yMax: 16 },
            { id: 'washington_heights', yMax: 22 }
        ]
    },
    brooklyn: {
        districts: [
            { id: 'dumbo', yMax: 3 },
            { id: 'williamsburg', yMax: 7 },
            { id: 'bed_stuy', yMax: 12 },
            { id: 'park_slope', yMax: 15 },
            { id: 'coney_island', yMax: 22 }
        ]
    },
    queens: {
        districts: [
             { id: 'astoria', yMax: 5 },
             { id: 'jackson_heights', yMax: 10 },
             { id: 'flushing', yMax: 15 },
             { id: 'jamaica', yMax: 22 }
        ]
    }
};

const RENT_MULTIPLIERS = {
    'financial_district': 2.5,
    'soho': 2.2,
    'upper_west_side': 1.8,
    'williamsburg': 1.5,
    'park_slope': 1.4,
    'harlem': 1.1,
    'coney_island': 0.9,
    'default': 1.0
};

// --- Procedural Generators ---

function getNeighborhood(borough, y) {
    const bData = BOROUGHS[borough];
    if (!bData) return `${borough}_general`;
    
    for (const district of bData.districts) {
        if (y <= district.yMax) return district.id;
    }
    return `${borough}_outskirts`;
}

function generateName(node, district) {
    // Use flavor text from locations.yaml if available
    const flavorList = dataLoader.worldData?.consistent_locations?.[node.type];
    
    if (flavorList && Math.random() < 0.7) {
        const pick = flavorList[Math.floor(Math.random() * flavorList.length)];
        return `${pick} (${district})`; // Add district to distinguish duplicates
    }
    
    // Fallback procedural names
    const streetNum = Math.floor(node.y * 10);
    const aveNum = Math.floor(node.x * 2);
    
    if (node.type === 'home') return `${district.replace('_', ' ').toUpperCase()} Residences #${node.key.split('_')[1]}`;
    if (node.type === 'office') return `${district} Professional Center`;
    return `${node.type.charAt(0).toUpperCase() + node.type.slice(1)} on ${streetNum}th St`;
}

function getAffordances(type) {
    const base = [{ action: 'fsm_idle' }];
    switch (type) {
        case 'home': return [...base, { action: 'fsm_sleeping' }, { action: 'fsm_eating' }, { action: 'fsm_maintenance' }, { action: 'fsm_socializing' }, { action: 'fsm_recreation' }];
        case 'office': return [...base, { action: 'fsm_working_office' }, { action: 'fsm_eating' }];
        case 'bar': return [...base, { action: 'fsm_socializing' }, { action: 'fsm_eating' }, { action: 'fsm_recreation' }];
        case 'restaurant': return [...base, { action: 'fsm_eating' }, { action: 'fsm_socializing' }];
        case 'park': return [...base, { action: 'fsm_socializing' }, { action: 'fsm_recreation' }];
        case 'store': return [...base, { action: 'fsm_shopping' }, { action: 'fsm_working_service' }];
        case 'library': return [...base, { action: 'fsm_recreation_quiet' }, { action: 'fsm_working_service' }];
        case 'subway': return [...base, { action: 'fsm_commuting' }]; // Transit nodes
        default: return base;
    }
}

// --- Main Hydration Function ---

export function hydrateWorldGraph(worldGraph) {
    const nodes = worldGraph.nodes; // Access the raw node map
    const nodeKeys = Object.keys(nodes);
    
    console.log(`[WorldSeeder] Hydrating ${nodeKeys.length} nodes with semantic data...`);
    
    let businessCount = 0;
    let homeCount = 0;

    nodeKeys.forEach(key => {
        const node = nodes[key];
        
        // 1. Identity & Geography
        node.neighborhood = getNeighborhood(node.borough, node.y);
        node.name = generateName(node, node.neighborhood);
        
        // 2. Environmental Physics (Used by Agent Sensory System)
        if (['bar', 'subway', 'street'].includes(node.type)) {
            node.noise = 0.7 + (Math.random() * 0.3); // 0.7 - 1.0
        } else if (['library', 'home'].includes(node.type)) {
            node.noise = Math.random() * 0.3; // 0.0 - 0.3
        } else {
            node.noise = 0.3 + (Math.random() * 0.3); // 0.3 - 0.6
        }
        
        node.condition = Math.floor(Math.random() * 40) + 60; // 60-100% initial condition
        
        // 3. Economics
        const rentMult = RENT_MULTIPLIERS[node.neighborhood] || 1.0;
        
        if (node.type === 'home') {
            homeCount++;
            const baseRent = 1200;
            // Rent calculation: Base * District Multiplier * Condition Factor
            node.rent_cost = Math.floor(baseRent * rentMult * (1 + (node.capacity / 10) * 0.1));
            node.luxury_tier = node.rent_cost > 2500 ? 3 : (node.rent_cost > 1800 ? 2 : 1);
            node.is_business = false;
        } else if (['store', 'bar', 'restaurant', 'office'].includes(node.type)) {
            businessCount++;
            node.is_business = true;
            node.treasury = Math.floor(Math.random() * 50000) + 10000;
            node.employee_ids = []; // Init empty staff list
            
            if (node.type === 'bar') node.open_hours = [17, 2]; // 5 PM - 2 AM
            else if (node.type === 'office') node.open_hours = [8, 18]; // 8 AM - 6 PM
            else node.open_hours = [9, 21]; // 9 AM - 9 PM
        } else {
            node.is_business = false;
        }

        // 4. AI Hints
        node.affordances = getAffordances(node.type);
        
        // Safety defaults
        if (!node.capacity) node.capacity = 10;
    });
    
    console.log(`[WorldSeeder] Complete. Enhanced ${homeCount} homes and ${businessCount} businesses.`);
}