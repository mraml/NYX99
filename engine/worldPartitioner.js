import worldGraph from '../data/worldGraph.js';
import logger from '../logger.js';

/**
 * worldPartitioner.js
 * * Creates a mapping from location IDs to worker (partition) IDs.
 * This is the core of the spatial partitioning system.
 * * (MODIFIED: Implemented Semantic Spatial Clustering. Nodes are sorted by
 * Borough -> Neighborhood -> ID before partitioning. This keeps logical
 * zones on the same worker, minimizing cross-worker serialization overhead.)
 */
class WorldPartitioner {
    constructor() {
        /**
         * @type {Map<string, number>}
         * Stores the mapping of locationId -> workerId
         */
        this.partitionMap = new Map();
        
        /**
         * @type {Map<number, Set<string>>}
         * Stores the mapping of workerId -> Set<locationId>
         */
        this.workerLocationMap = new Map();
        this.numPartitions = 0;
    }

    /**
     * Partitions the world graph among a set number of workers.
     * * @param {number} numPartitions - The number of workers to partition for.
     * @returns {{partitionMap: Map<string, number>, workerLocationMap: Map<number, Set<string>>}}
     */
    partitionWorld(numPartitions) {
        logger.info(`[WorldPartitioner] Partitioning world into ${numPartitions} zones using Semantic Clustering...`);
        this.numPartitions = numPartitions;
        
        const rawNodes = worldGraph.nodes;
        const locationIds = Object.keys(rawNodes);
        
        if (locationIds.length === 0) {
            logger.error('[WorldPartitioner] World graph has no nodes to partition.');
            return;
        }

        // Initialize worker location map
        for (let i = 0; i < numPartitions; i++) {
            this.workerLocationMap.set(i, new Set());
        }

        // --- Semantic Clustering Implementation ---
        // 1. Create sortable objects with semantic metadata
        const sortableNodes = locationIds.map(id => {
            const node = rawNodes[id];
            return {
                id: id,
                // Fallback to 'z_unknown' to push undefined areas to the end of the list
                borough: node.borough || 'z_unknown',
                neighborhood: node.neighborhood || 'z_unknown'
            };
        });

        // 2. Sort by Borough, then Neighborhood, then ID
        // This ensures all nodes in "Manhattan" stay together in the list,
        // and within Manhattan, "SoHo" nodes stay together.
        sortableNodes.sort((a, b) => {
            const boroughDiff = a.borough.localeCompare(b.borough);
            if (boroughDiff !== 0) return boroughDiff;
            
            const hoodDiff = a.neighborhood.localeCompare(b.neighborhood);
            if (hoodDiff !== 0) return hoodDiff;
            
            return a.id.localeCompare(b.id);
        });

        // 3. Distribute chunks to workers
        // Using simple chunking on the *sorted* list ensures spatial locality.
        const chunkSize = Math.ceil(sortableNodes.length / numPartitions);

        sortableNodes.forEach((nodeObj, index) => {
            const workerId = Math.floor(index / chunkSize);
            
            // Safety clamp in case of rounding errors
            const safeWorkerId = Math.min(workerId, numPartitions - 1);

            this.partitionMap.set(nodeObj.id, safeWorkerId);
            this.workerLocationMap.get(safeWorkerId).add(nodeObj.id);
        });

        logger.info(`[WorldPartitioner] Partitioning complete.`);
        this.workerLocationMap.forEach((locations, workerId) => {
            const sampleId = locations.values().next().value;
            const sampleNode = rawNodes[sampleId];
            const zoneName = sampleNode ? `${sampleNode.borough}/${sampleNode.neighborhood}` : 'Unknown';
            logger.info(`  - Partition ${workerId}: ${locations.size} locations (Zone: ${zoneName}...)`);
        });

        return {
            partitionMap: this.partitionMap,
            workerLocationMap: this.workerLocationMap
        };
    }

    /**
     * Gets the worker ID for a given location.
     * @param {string} locationId
     * @returns {number} The worker ID, or 0 as a fallback.
     */
    getWorkerIdForLocation(locationId) {
        return this.partitionMap.get(locationId) ?? 0; // Default to worker 0
    }
}

// Export a singleton instance
export const worldPartitioner = new WorldPartitioner();