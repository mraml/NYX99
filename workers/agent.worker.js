import { parentPort } from 'worker_threads';
import { dataLoader } from '../data/dataLoader.js';
import worldGraph from '../data/worldGraph.js';
import * as agentService from '../services/agentService.js';
import { FiniteStateMachine } from '../engine/fsm.js'; 
import Agent from '../engine/agent.js'; 
import * as socialService from '../services/socialService.js';
// [REF] Removed perceptionService import as it is now handled inside agentService
// import * as perceptionService from '../services/perceptionService.js'; 

// --- Worker-Local State ---
let isInitialized = false;
let partition = { workerId: -1, locations: new Set() };
const collectedEvents = [];

// Mock Matrix for the Worker Context
const workerMatrixMock = {
    tickCount: 0,
    worldTime: new Date(),
    worldState: {},
    locationAgentCount: {},
    eventBus: {
        queue: (type, priority, ...args) => {
            collectedEvents.push(['queue', type, priority, ...args]);
        },
        emitNow: (type, ...args) => {
            collectedEvents.push([type, ...args]);
        },
        debug: false
    },
    cacheManager: {
        getAgent: () => null,
        getAllAgents: () => [] 
    }
};

function serializeForIPC(agent) {
    return {
        id: agent.id,
        name: agent.name,
        state: agent.state,
        locationId: agent.locationId,
        money: agent.money,
        energy: agent.energy,
        hunger: agent.hunger,
        social: agent.social,
        mood: agent.mood,
        stress: agent.stress,
        currentActivityName: agent.currentActivityName,
        inventory: agent.inventory,
        status_effects: agent.status_effects,
        recentActivities: agent.recentActivities,
        relationships: agent.relationships,
        history: agent.history,
        intentionStack: agent.intentionStack,
        // [REF] Pass stateContext across IPC for UI/Debug/Persistence
        stateContext: agent.stateContext
    };
}

async function initializeWorker(initPayload) {
    try {
        const workerId = initPayload.partition.workerId;
        console.log(`[Worker ${workerId}] Starting initialization...`);
        
        partition.workerId = workerId;
        partition.locations = new Set(initPayload.partition.locations);

        console.log(`[Worker ${workerId}] Loading data...`);
        await dataLoader.loadAllData();
        console.log(`[Worker ${workerId}] Data loaded, initializing worldGraph...`);
        
        worldGraph.init();
        console.log(`[Worker ${workerId}] WorldGraph initialized with ${Object.keys(worldGraph.nodes).length} nodes`);
        
        FiniteStateMachine.clearPathCache();
        
        const invalidLocs = Array.from(partition.locations).filter(loc => !worldGraph.nodes[loc]);
        if (invalidLocs.length > 0) {
            throw new Error(`Worker ${workerId}: ${invalidLocs.length} invalid locations in partition. First few: ${invalidLocs.slice(0, 5).join(', ')}`);
        }

        isInitialized = true;
        console.log(`[Worker ${workerId}] Initialization complete!`);
        parentPort.postMessage({ type: 'INIT_COMPLETE', workerId: partition.workerId });
    } catch (err) {
        console.error(`[Worker ${initPayload.partition.workerId}] Init Failed:`, err);
        console.error(err.stack);
        parentPort.postMessage({ 
            type: 'INIT_FAILED', 
            error: err.message, 
            workerId: initPayload.partition.workerId 
        });
    }
}

async function processTick(tickPayload) {
    if (!isInitialized) {
        console.error(`[Worker ${partition.workerId}] Received TICK before initialization complete!`);
        return;
    }

    collectedEvents.length = 0;
    const { 
        agentsData, 
        tickCount, 
        worldTime, 
        worldState, 
        locationAgentCount,
        worldEvents
    } = tickPayload;

    const parsedTime = new Date(worldTime);
    const hour = parsedTime.getHours();

    worldGraph.updateDynamicState(parsedTime, worldEvents || [], new Map(Object.entries(locationAgentCount || {})));
    
    workerMatrixMock.tickCount = tickCount;
    workerMatrixMock.worldTime = parsedTime;
    workerMatrixMock.worldState = worldState;
    workerMatrixMock.locationAgentCount = locationAgentCount;

    // Hydrate Agents
    const agents = agentsData.map(data => {
        const agent = new Agent(data);
        agent.matrix = workerMatrixMock; 
        if (!agent.fsm) agent.fsm = new FiniteStateMachine(agent);
        return agent;
    });

    workerMatrixMock.cacheManager.getAllAgents = () => agents;

    // [REF] Removed redundant perception loop.
    // perceptionService.runPerception is now called inside agentService.updateAgent

    const walOps = [];
    
    const agentUpdatePromises = agents.map(async (agent) => {
        try {
            const updateResult = await agentService.updateAgent(agent, workerMatrixMock, hour);
            if (updateResult && updateResult.walOp) {
                walOps.push(updateResult.walOp);
            }
        } catch (err) {
            console.error(`[Worker ${partition.workerId}] Error updating agent ${agent.id}:`, err);
            collectedEvents.push(['system:error', { error: `Agent ${agent.id} crash: ${err.message}`, tick: tickCount }]);
        }
    });

    await Promise.all(agentUpdatePromises);

    const localSocialContext = new Map();
    const lod1AgentsInPartition = [];

    for (const agent of agents) {
        if (agent.lod === 1) lod1AgentsInPartition.push(agent);

        if (agent.locationId) {
            if (!localSocialContext.has(agent.locationId)) {
                localSocialContext.set(agent.locationId, []);
            }
            localSocialContext.get(agent.locationId).push({
                id: agent.id,
                name: agent.name,
                state: agent.state,
                minActivityDuration: agent.minActivityDuration,
                inConversation: agent.state === 'fsm_socializing' && !!agent.stateContext?.conversationPartner, // [REF] Check context
                mood: agent.mood,
                stress: agent.stress,
                currentActivityName: agent.currentActivityName,
                persona: agent.persona,
                interests: agent.interests,
                job: agent.job
            });
        }
    }
    
    if (lod1AgentsInPartition.length > 0) {
        try {
            socialService.processSocialInteractions(
                lod1AgentsInPartition,
                worldGraph.nodes, 
                workerMatrixMock.eventBus, 
                tickCount
            );
        } catch (err) {
            console.error(`[Worker ${partition.workerId}] Social Service Error:`, err);
        }
    }

    const updatedAgents = agents.map(agent => serializeForIPC(agent));
    const socialContextArray = Array.from(localSocialContext.entries());

    parentPort.postMessage({
        type: 'TICK_COMPLETE',
        workerId: partition.workerId, 
        updatedAgents,
        walOps,
        socialContext: socialContextArray,
        logEvents: collectedEvents 
    });
}

parentPort.on('message', async (msg) => {
    switch (msg.type) {
        case 'INIT':
            await initializeWorker(msg.payload);
            break;
        case 'TICK':
            await processTick(msg.payload);
            break;
        case 'CLEAR_PATH_CACHE':
            FiniteStateMachine.clearPathCache();
            break;
        case 'SHUTDOWN':
            process.exit(0);
            break;
    }
});