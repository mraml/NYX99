import { BaseState } from './BaseState.js';
import { SOCIAL_FAIL_TICK_LIMIT } from '../../data/config.js'; 
import { GAME_BALANCE } from '../../data/balance.js';
import worldGraph from '../../data/worldGraph.js';
import eventBus from '../../engine/eventBus.js';

export class SocializingState extends BaseState {
    
    // [REF] Stateless Architecture: Removed constructor

    // [REF] Added agent param
    enter(agent, params = {}) {
        super.enter(agent);
        
        // [REF] Move stateful properties to agent.stateContext
        agent.stateContext.ticksInState = 0;
        agent.stateContext.searchTicks = 0;
        agent.stateContext.waitingForReply = false;
        agent.stateContext.distractionTicks = 0; 
        agent.stateContext.isDigital = false;
        
        // Target ID usually comes from params or intent
        agent.stateContext.targetAgentId = params.targetAgentId || null;
        agent.stateContext.conversationPartner = null;
        agent.stateContext.distractionDuration = params.context?.duration || null;

        if (agent.stateContext.targetAgentId) {
            agent.currentActivity = `Looking for specific person...`;
        } else {
            this._updateActivityFromState(agent);
        }
    }

    // [REF] Added agent param
    tick(agent, hour, localEnv, worldState) {
        super.tick(agent, hour, localEnv, worldState, { 
            skipSocial: true,
            skipStressCalculation: true 
        });
        
        let isDirty = (worldState.currentTick % 10 === 0);

        // --- 0. Interruptions ---
        const isLate = hour >= 1 && hour < 6; 
        if (isLate && !agent.stateContext.isDigital && agent.locationId !== agent.homeLocationId) {
             return this.endConversation(agent, "It's getting late, I should head home.");
        }

        agent.stateContext.distractionTicks++;
        if (agent.stateContext.distractionDuration !== null && agent.stateContext.distractionTicks >= agent.stateContext.distractionDuration) {
            return this.endConversation(agent, "Distraction over.");
        }

        agent.stateContext.ticksInState++;

        // --- 1. ACTIVE CONVERSATION LOGIC ---
        if (agent.stateContext.conversationPartner || agent.stateContext.isDigital) {
            return this._handleActiveConversation(agent, worldState, isDirty);
        }

        // --- 2. SEARCH LOGIC ---
        if (agent.stateContext.waitingForReply) {
            agent.stateContext.searchTicks++;
            const target = worldState.agents?.[agent.stateContext.targetAgentId]; 

            // Note: Accessing target.fsm.currentStateInstance is tricky in Stateless.
            // We should check target.state and potentially target.stateContext (if available/exposed).
            // BUT stateContext is internal to the agent instance. We might not have access if 'agents' are just light wrappers.
            // Assuming worldState.agents are full instances:
            
            // FIX: Robust check for partner state.
            // Since states are singletons, we can't check `currentStateInstance.targetAgentId`.
            // We must check `target.stateContext.targetAgentId`.
            
            if (target && 
                target.locationId === agent.locationId &&
                target.state === 'fsm_socializing' &&
                target.stateContext?.targetAgentId === agent.id) 
            {
                this.startConversation(agent, target);
                // Ensure partner also starts (Mutual lock-in)
                if (target.state === 'fsm_socializing') {
                     // We can't call methods on target's state easily from here without `target.fsm`.
                     // But we can manually set their context if we are simulating on the same thread.
                     // Better: The target's own tick will see US and start conversation.
                }
            } 
            else if (!target || target.locationId !== agent.locationId || agent.stateContext.searchTicks > 5) {
                agent.stateContext.waitingForReply = false;
                agent.stateContext.targetAgentId = null; 
            }
            return { isDirty: true, walOp: null };
        }

        // --- 3. INITIATION LOGIC ---
        if (agent.stateContext.targetAgentId) {
            return this.runTargetedSocialization(agent, worldState);
        }
        return this.runGenericSocialization(agent, worldState);
    }

    // [REF] Added agent param
    _handleActiveConversation(agent, worldState, isDirty) {
        let partner = agent.stateContext.isDigital ? null : worldState.agents?.[agent.stateContext.conversationPartner?.id];

        // Break condition
        if (!agent.stateContext.isDigital) {
            if (!partner || partner.locationId !== agent.locationId || partner.state !== 'fsm_socializing') {
                return this.endConversation(agent, `Chat ended.`);
            }
        }

        const extroversion = agent.persona?.extroversion ?? 0.5;
        
        if (extroversion < 0.4) {
            agent.energy = Math.max(0, (agent.energy ?? 0) - 0.2);
            if (agent.energy < 20 && Math.random() < 0.05) {
                return this.endConversation(agent, "Social battery depleted.");
            }
        } else {
            agent.energy = Math.min(100, (agent.energy ?? 0) + 0.1);
        }

        let qualityMult = 1.0;
        
        if (!agent.stateContext.isDigital) {
            const loc = worldGraph.nodes[agent.locationId];
            if (loc && ['bar', 'restaurant', 'park', 'cafe'].includes(loc.type)) {
                qualityMult += 0.5;
            }
        } else {
            qualityMult = 0.7; 
        }

        let interestBonus = 1.0;
        const partnerInterests = agent.stateContext.isDigital ? (agent.stateContext.digitalPartnerInterests || []) : (partner?.interests || []);
        const common = (agent.interests || []).filter(i => partnerInterests.includes(i));
        
        if (common.length > 0) {
            interestBonus = 1.2 + (common.length * 0.1);
            if (Math.random() < 0.05 && isDirty) {
                agent.stress = Math.max(0, (agent.stress ?? 0) - 5); 
            }
        }

        const effectiveRegen = (GAME_BALANCE.REGEN.SOCIALIZE * 1.5) * qualityMult * interestBonus;
        agent.social = Math.max(0, (agent.social ?? 0) - effectiveRegen);
        agent.mood = Math.min(100, (agent.mood ?? 0) + (1.0 * interestBonus));

        if (Math.random() < 0.02) {
            this._triggerConversationEvent(agent, partner, interestBonus);
        }

        if (agent.social < 5 && agent.stateContext.ticksInState > 20) {
             return this.endConversation(agent, `Social meter full.`);
        }
        
        if (agent.stateContext.ticksInState > 120) { 
            return this.endConversation(agent, `Ran out of things to say.`);
        }

        return { isDirty, walOp: null };
    }

    // [REF] Added agent param
    _triggerConversationEvent(agent, partner, interestBonus) {
        const partnerName = agent.stateContext.isDigital ? (agent.stateContext.digitalPartnerName || "Friend") : partner.name;
        
        const isDeep = interestBonus > 1.2;
        
        const events = isDeep ? [
            { text: "shared a personal secret", mood: 10, stress: -10 },
            { text: "discussed their hopes and dreams", mood: 8, stress: -5 },
            { text: "vented about work", stress: -15 } 
        ] : [
            { text: "joked about the weather", mood: 2 },
            { text: "gossiped about neighbors", mood: 3 },
            { text: "shared a meme", mood: 4 }
        ];

        const evt = events[Math.floor(Math.random() * events.length)];
        
        if (evt.mood) agent.mood = Math.max(0, Math.min(100, (agent.mood ?? 0) + evt.mood));
        if (evt.stress) agent.stress = Math.max(0, Math.min(100, (agent.stress ?? 0) + evt.stress));
        
        if (Math.abs(evt.mood || 0) > 5 || Math.abs(evt.stress || 0) > 5) {
            const medium = agent.stateContext.isDigital ? "over text" : "face-to-face";
            eventBus.emit('db:writeMemory', 'low', agent.id, agent.matrix?.tickCount || 0, `Chatted with ${partnerName} ${medium}: ${evt.text}.`);
        }
    }

    // [REF] Added agent param
    runGenericSocialization(agent, worldState) {
        agent.socializingTicks = (agent.socializingTicks || 0) + 1;
        
        if (agent.socializingTicks >= 3) {
            if (!worldState.locationSocialContext) return this.endConversation(agent, 'World context missing.');
            
            const agentsHere = worldState.locationSocialContext.get(agent.locationId) || [];
            
            const candidates = agentsHere.filter(a => {
                const isBusy = a.state.startsWith('fsm_working_') || a.state === 'fsm_sleeping' || a.state === 'fsm_commuting' || a.state === 'fsm_in_transit';
                return a.id !== agent.id && !isBusy && !a.inConversation;
            });
            
            if (candidates.length > 0) {
                candidates.sort((a, b) => {
                    const relA = agent.relationships?.[a.id]?.score || 0;
                    const relB = agent.relationships?.[b.id]?.score || 0;
                    return relB - relA; 
                });

                const partner = candidates[0];
                agent.stateContext.targetAgentId = partner.id;
                return this.runTargetedSocialization(agent, worldState);
            } 
            else {
                if (this._tryStartDigitalConversation(agent, worldState)) {
                    return { isDirty: true, walOp: null };
                }

                agent.social = Math.max(0, (agent.social ?? 0) - 5); 
                return this.endConversation(agent, 'No one to talk to.');
            }
        }

        return { isDirty: false, walOp: null };
    }

    // [REF] Added agent param
    _tryStartDigitalConversation(agent, worldState) {
        if (!agent.relationships) return false;

        const friends = Object.entries(agent.relationships)
            .map(([id, rel]) => ({ id, score: rel.score }))
            .filter(f => f.score > 50) 
            .sort((a, b) => b.score - a.score);

        for (let friend of friends) {
            const friendAgent = worldState.agents?.[friend.id];
            if (friendAgent && friendAgent.state !== 'fsm_sleeping') {
                agent.stateContext.isDigital = true;
                agent.stateContext.digitalPartnerName = friendAgent.name;
                agent.stateContext.digitalPartnerInterests = friendAgent.interests; 
                agent.stateContext.ticksInState = 0;
                
                agent.currentActivityName = 'texting';
                this._updateActivityFromState(agent); 
                
                this.log(`[${agent.name}] Room empty. Texting ${friendAgent.name} instead.`);
                return true;
            }
        }
        return false;
    }

    // [REF] Added agent param
    runTargetedSocialization(agent, worldState) {
        if (agent.stateContext.isDigital) return { isDirty: false, walOp: null };

        const target = worldState.agents?.[agent.stateContext.targetAgentId]; 

        if (target && target.locationId === agent.locationId) {
            const isTargetBusy = target.state.startsWith('fsm_working_') || 
                                 target.state === 'fsm_sleeping' ||
                                 target.state === 'fsm_commuting';

            // [REF] Check target context
            const isTargetInConversation = target.state === 'fsm_socializing' &&
                                           target.stateContext?.conversationPartner;

            if (!isTargetBusy && !isTargetInConversation) {
                // Send Request
                agent.matrix?.eventBus.queue('agent:requestConversation', {
                    from: agent.id,
                    to: target.id
                });
                agent.stateContext.waitingForReply = true;
                
                agent.currentActivityName = 'request_chat';
                this._updateActivityFromState(agent); 
            } else {
                return this.endConversation(agent, `${target.name} is busy.`);
            }
        } else {
             return this.endConversation(agent, `Couldn't find them.`);
        }
        return { isDirty: true, walOp: null };
    }

    // [REF] Added agent param
    startConversation(agent, partner) {
        if (agent.stateContext.conversationPartner) return; 
        agent.stateContext.conversationPartner = partner;
        agent.stateContext.ticksInState = 0;
        agent.stateContext.waitingForReply = false;
        agent.stateContext.targetAgentId = partner.id;
        
        agent.currentActivityName = 'chatting';
        this._updateActivityFromState(agent);

        const affinityBoost = calculateAffinityBoost(agent, partner);
        
        agent.updateRelationship(partner.id, affinityBoost, null, { 
            type: 'chat', 
            description: `Chatted with ${partner.name}`,
            tick: agent.matrix?.tickCount || 0
        });

        agent.socializingSuccess = true;
    }

    // [REF] Added agent param
    endConversation(agent, reason) {
        this.log(`[${agent.name}] ${reason}`);
        
        if (agent.stateContext.conversationPartner) {
            agent.lastSocialPartner = agent.stateContext.conversationPartner.id;
        }

        if (!agent.status_effects) agent.status_effects = [];
        
        if (reason.includes("Meter full") || reason.includes("Chat ended")) {
             agent.status_effects.push({
                type: 'CONNECTED',
                duration: 120, 
                magnitude: 0.5 
            });
        }

        agent.stateContext.conversationPartner = null;
        agent.stateContext.targetAgentId = null;
        agent.stateContext.isDigital = false;
        
        const currentIntention = agent.intentionStack?.[agent.intentionStack.length - 1];
        if (currentIntention && currentIntention.goal === 'fsm_socializing') {
             if (agent.intentionStack) agent.intentionStack.pop();
        }
        
        return { isDirty: true, walOp: null, nextState: 'fsm_idle' };
    }
}

function calculateAffinityBoost(agent1, agent2) {
  const extro1 = agent1.persona?.extroversion ?? 0.5;
  const extro2 = agent2.persona?.extroversion ?? 0.5;
  let boost = 2;
  if (extro1 > 0.6 && extro2 > 0.6) boost += 2;
  return boost;
}