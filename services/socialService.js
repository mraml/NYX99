import { 
  shouldLogThinking, 
  LOG_ALL_SOCIALS_TO_MEMORY, 
  LOG_RELATIONSHIP_MILESTONES 
} from '../data/config.js';
import { dataLoader } from '../data/dataLoader.js'; // <-- IMPORTED DATA LOADER

// If RELATIONSHIP_AFFINITY_GAIN was removed from config, we define a fallback here or use balance.js
const BASE_AFFINITY_GAIN = 1.0; 

/**
 * services/socialService.js
 *
 * Handles all socialization logic.
 * (MODIFIED v10.0: Integrated culture.yaml for dynamic dialogue and topics)
 */

function getRandomElement(arr) {
    if (!arr || arr.length === 0) return null;
    return arr[Math.floor(Math.random() * arr.length)];
}

// --- NEW: Cultural Topic Generator ---
function generateConversationTopic(agentA, agentB) {
    const culture = dataLoader.worldData || {};
    const allTopics = culture.conversation_topics || [];
    const slang = culture.common_slang_1999 || [];
    
    // 1. Find shared interests
    const interestsA = agentA.interests || [];
    const interestsB = agentB.interests || [];
    const shared = interestsA.filter(i => interestsB.includes(i));
    
    let relevantTopics = [];
    
    // 2. Filter topics by shared interests or general relevance
    if (shared.length > 0) {
        relevantTopics = allTopics.filter(t => t.interest_tags && t.interest_tags.some(tag => shared.includes(tag)));
    }
    
    // Fallback to general/high relevance topics
    if (relevantTopics.length === 0) {
        relevantTopics = allTopics.filter(t => t.relevance === 'very_high' || t.relevance === 'high');
    }
    
    const selectedTopic = getRandomElement(relevantTopics) || { topic: "the weather" };
    const selectedSlang = Math.random() < 0.3 ? getRandomElement(slang) : "";
    
    return { topic: selectedTopic.topic, slang: selectedSlang };
}

function determineSocialEventType(affinityChange, topicData) {
  const rand = Math.random();
  const { topic, slang } = topicData;
  const slangStr = slang ? ` "${slang}"` : "";
  
  // Positive Events
  if (affinityChange > 0.5) {
    if (rand < 0.1) return { 
        type: 'DATE', 
        baseAffinityMod: 10, 
        description: `Went on a surprisingly good date, talked about ${topic}.`, 
        memoryText: `We went on a date and bonded over ${topic}.${slangStr} It went really well!` 
    };
    if (rand < 0.2) return { 
        type: 'BONDING', 
        baseAffinityMod: 8, 
        description: `Had a deep talk about ${topic}.`, 
        memoryText: `We really connected over ${topic} today. I feel like I can trust them.` 
    };
    return { 
        type: 'CASUAL_CHAT', 
        baseAffinityMod: 5, 
        description: `Chatted about ${topic}.`, 
        memoryText: `Good chat about ${topic}.${slangStr}` 
    };
  } 
  // Negative Events
  else if (affinityChange < -0.5) {
    if (rand < 0.1) return { 
        type: 'ARGUMENT', 
        baseAffinityMod: -15, 
        description: `Got into a fight about ${topic}.`, 
        memoryText: `We got into a terrible argument over ${topic}. I feel awful.` 
    };
    return { 
        type: 'TENSE_CHAT', 
        baseAffinityMod: -5, 
        description: `Awkward conversation about ${topic}.`, 
        memoryText: `The chat about ${topic} was tense. Something felt off.` 
    };
  }
  // Neutral Events
  return { 
      type: 'CASUAL_CHAT', 
      baseAffinityMod: 0, 
      description: `Briefly mentioned ${topic}.`, 
      memoryText: `We briefly discussed ${topic}.` 
  };
}

export function processSocialInteractions(lod1Agents, worldNodes, eventBus, tickCount) {
  const socializingAgents = lod1Agents.filter(a => a.state === 'fsm_socializing');
  const processed = new Set();

  for (const agentA of socializingAgents) {
    if (processed.has(agentA.id)) continue;

    const potentialPartners = socializingAgents.filter(p =>
      !processed.has(p.id) &&
      p.id !== agentA.id &&
      p.locationId === agentA.locationId
    );

    if (potentialPartners.length === 0) continue;

    potentialPartners.sort((a, b) =>
      (agentA.getRelationship(b.id).affinity ?? 0) - (agentA.getRelationship(a.id).affinity ?? 0)
    );

    const partner = potentialPartners[0];
    
    agentA.socializingSuccess = true;
    partner.socializingSuccess = true;
    processed.add(agentA.id);
    processed.add(partner.id);

    const relABefore = agentA.getRelationship(partner.id);

    let affinityChangeA = BASE_AFFINITY_GAIN;
    let affinityChangeB = BASE_AFFINITY_GAIN;

    // --- Personality Logic (Simplified for brevity, logic exists in SocializingState too) ---
    const extroversionA = agentA.persona?.extroversion ?? 0.5;
    if (extroversionA > 0.7) affinityChangeA += 0.5;
    
    // --- NEW: Culture Integration ---
    const topicData = generateConversationTopic(agentA, partner);
    
    const socialEvent = determineSocialEventType(affinityChangeA, topicData);
    const eventAffinityMod = socialEvent.baseAffinityMod; 

    affinityChangeA += eventAffinityMod;
    affinityChangeB += eventAffinityMod; 
    
    const historyEventA = {
        type: socialEvent.type,
        description: socialEvent.description,
        tick: tickCount,
        affinity: eventAffinityMod, 
    };
    // (Partner history is symmetric)

    agentA.updateRelationship(partner.id, affinityChangeA, null, historyEventA);
    partner.updateRelationship(agentA.id, affinityChangeB, null, historyEventA);

    const newRelA = agentA.getRelationship(partner.id);

    // --- Move In Logic ---
    let movedIn = false;
    if (newRelA.type === 'romantic_partner' && (newRelA.affinity ?? 0) > 95 &&
        !agentA.partnerId && !partner.partnerId &&
        agentA.homeLocationId !== partner.homeLocationId &&
        Math.random() < 0.05) {
        
        agentA.partnerId = partner.id;
        partner.partnerId = agentA.id;
        partner.homeLocationId = agentA.homeLocationId;
        movedIn = true;
        
        eventBus.queue('log:info', 'high', `[Life Event] ${agentA.name} and ${partner.name} moved in together!`);
        eventBus.queue('db:writeMemory', 'high', agentA.id, tickCount, `I asked ${partner.name} to move in, and they said yes!`);
    }
    
    // --- Memory Logging ---
    eventBus.queue('db:writeMemory', 'low', agentA.id, tickCount, socialEvent.memoryText);
    eventBus.queue('db:writeMemory', 'low', partner.id, tickCount, socialEvent.memoryText);

    // --- Relationship Milestone Log ---
    if (newRelA.type !== relABefore.type) {
      eventBus.queue('log:info', 'medium', `[Relationship] ${agentA.name} & ${partner.name}: ${relABefore.type} → ${newRelA.type}`);
    }
    
    const node = worldNodes[agentA.locationId];
    const logMsg = `[Matrix] ${agentA.name} & ${partner.name} @ ${node?.name}: "${topicData.topic}" (${newRelA.affinity.toFixed(0)})`;
    eventBus.queue('log:info', 'low', logMsg);
  }
}