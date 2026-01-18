import { BaseState } from './BaseState.js';
import { Selector, Sequence, Condition, Action, Inverter, Status } from '../BehaviorTreeCore.js';
import { SOCIAL_FAIL_TICK_LIMIT } from '../../data/config.js'; 
import { GAME_BALANCE } from '../../data/balance.js';
import worldGraph from '../../data/worldGraph.js';
import eventBus from '../../engine/eventBus.js';

// === 1. LEAF NODES (LOGIC) ===

const Actions = {
    EndConversation: (agent, { reason }) => {
        if (agent.stateContext.conversationPartner) {
             agent.lastSocialPartner = agent.stateContext.conversationPartner.id;
        }
        // Cleanup happens in FSM transition, but we can log specific reasons here
        if (agent.lod === 1) console.log(`[${agent.name}] Ending chat: ${reason || 'Done'}`);
        
        if (agent.intentionStack) agent.intentionStack.pop();
        return { isDirty: true, nextState: 'fsm_idle' };
    },

    HandleActiveChat: (agent, context) => {
        agent.stateContext.ticksInState++;
        const partner = agent.stateContext.isDigital 
            ? null 
            : context.worldState.agents?.[agent.stateContext.conversationPartner?.id];

        // 1. Validation Check: Is partner still here?
        if (!agent.stateContext.isDigital) {
            if (!partner || partner.locationId !== agent.locationId || partner.state !== 'fsm_socializing') {
                return Actions.EndConversation(agent, { reason: "Partner left." });
            }
        }

        // 2. Regen Stats
        const qualityMult = agent.stateContext.isDigital ? 0.7 : 1.2;
        const effectiveRegen = (GAME_BALANCE.REGEN.SOCIALIZE || 5) * qualityMult;
        
        agent.social = Math.max(0, (agent.social ?? 0) - effectiveRegen);
        agent.mood = Math.min(100, (agent.mood ?? 0) + 0.5);

        // 3. Exit Conditions
        if (agent.social < 5) return Actions.EndConversation(agent, { reason: "Social battery full." });
        if (agent.stateContext.ticksInState > 120) return Actions.EndConversation(agent, { reason: "Ran out of topics." });

        return Status.RUNNING;
    },

    CheckForReply: (agent, context) => {
        agent.stateContext.searchTicks++;
        const target = context.worldState.agents?.[agent.stateContext.targetAgentId];
        
        // Timeout check
        if (agent.stateContext.searchTicks > 10) {
            agent.stateContext.waitingForReply = false;
            agent.stateContext.targetAgentId = null;
            
            // FIX: Don't just return FAILURE (which falls through to search).
            // Explicitly give up or switch mode to prevent rapid loop.
            if (Math.random() < 0.5) {
                 return Actions.StartDigitalChat(agent); // Fallback to phone
            }
            return Actions.EndConversation(agent, { reason: "No reply." });
        }

        // Success check: Target is now socializing with US
        if (target && 
            target.state === 'fsm_socializing' && 
            target.stateContext?.targetAgentId === agent.id) 
        {
            // Handshake complete!
            agent.stateContext.conversationPartner = target;
            agent.stateContext.waitingForReply = false;
            agent.stateContext.ticksInState = 0;
            return Status.SUCCESS;
        }

        return Status.RUNNING; // Keep waiting
    },

    FindNewPartner: (agent, context) => {
        if (!context.worldState.locationSocialContext) return Status.FAILURE;
        
        const agentsHere = context.worldState.locationSocialContext.get(agent.locationId) || [];
        
        // Filter valid candidates
        const candidates = agentsHere.filter(a => {
            if (a.id === agent.id) return false;
            if (a.inConversation) return false; // Already chatting
            // Busy check
            return !['fsm_sleeping', 'fsm_commuting', 'fsm_working'].includes(a.state);
        });

        if (candidates.length > 0) {
            // Pick random or best relationship
            const partner = candidates[0];
            agent.stateContext.targetAgentId = partner.id;
            agent.stateContext.waitingForReply = true;
            agent.stateContext.searchTicks = 0;

            // Send signal (simulated via EventBus)
            context.worldState.eventBus?.queue('agent:requestConversation', { from: agent.id, to: partner.id });
            
            return Status.SUCCESS;
        }

        return Status.FAILURE; // No one here
    },

    StartDigitalChat: (agent) => {
        // Fallback: Text a friend
        agent.stateContext.isDigital = true;
        agent.stateContext.ticksInState = 0;
        return Status.SUCCESS;
    }
};

const Conditions = {
    IsCurfew: (agent, { hour }) => (hour >= 1 && hour < 6),
    IsInConversation: (agent) => !!(agent.stateContext.conversationPartner || agent.stateContext.isDigital),
    IsWaitingForReply: (agent) => !!agent.stateContext.waitingForReply,
    HasTarget: (agent) => !!agent.stateContext.targetAgentId
};

// === 2. BEHAVIOR TREE ===

const SocializingTree = new Selector([
    // 1. Interruptions (Priority High)
    new Sequence([
        new Condition(Conditions.IsCurfew),
        new Action((a) => Actions.EndConversation(a, { reason: "Curfew" }))
    ]),

    // 2. Active Conversation Loop
    new Sequence([
        new Condition(Conditions.IsInConversation),
        new Action(Actions.HandleActiveChat)
    ]),

    // 3. Waiting for Handshake
    new Sequence([
        new Condition(Conditions.IsWaitingForReply),
        new Action(Actions.CheckForReply)
    ]),

    // 4. Initiation Phase
    new Selector([
        // A: Try to find someone physical
        new Sequence([
            new Inverter(new Condition(Conditions.HasTarget)), // Only if we don't have a target yet
            new Action(Actions.FindNewPartner)
        ]),
        // B: If that fails, try digital
        new Sequence([
            new Inverter(new Condition(Conditions.HasTarget)),
            new Action(Actions.StartDigitalChat)
        ]),
        // C: If all fails, give up
        new Action((a) => Actions.EndConversation(a, { reason: "No one to talk to." }))
    ])
]);

// === 3. STATE CLASS ===

export class SocializingState extends BaseState {
    enter(agent, params = {}) {
        super.enter(agent);
        this._updateActivityFromState(agent);
        
        agent.stateContext.ticksInState = 0;
        agent.stateContext.searchTicks = 0;
        agent.stateContext.waitingForReply = false;
        agent.stateContext.isDigital = false;
        agent.stateContext.conversationPartner = null;
        agent.stateContext.targetAgentId = params.targetAgentId || null; // Can start with a target from Intent

        if (agent.stateContext.targetAgentId) {
            agent.stateContext.waitingForReply = true;
        }
    }

    tick(agent, hour, localEnv, worldState) {
        super.tick(agent, hour, localEnv, worldState, { skipSocial: true });
        
        const context = { hour, localEnv, worldState, transition: null };
        const status = SocializingTree.execute(agent, context);

        if (context.transition) {
            return context.transition;
        }

        return { isDirty: (worldState.currentTick % 10 === 0), walOp: null };
    }
}