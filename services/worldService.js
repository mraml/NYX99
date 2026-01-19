import worldGraph from '../data/worldGraph.js';
import { 
  MINUTES_PER_TICK,
} from '../data/config.js';
import { dataLoader } from '../data/dataLoader.js';
import { GAME_BALANCE } from '../data/balance.js'; 

/**
 * services/worldService.js
 *
 * Handles all "idle game" logic for the persistent world,
 * including business economies, rent, and degradation.
 * (REFACTORED: Now sourcing strictly from events.yaml, weather_patterns.yaml, locations.yaml)
 */

const CONSOLIDATION_AGE_TICKS = 192; 
let lastNewsUpdateTick = 0;
const NEWS_UPDATE_INTERVAL_TICKS = 60; 

let _weatherWeightSum = 0;

export function initWorldService() {
  // Source: weather_patterns.yaml
  const weatherSource = dataLoader.weatherPatterns || dataLoader.worldData?.weather_patterns;

  if (weatherSource) {
    // If the yaml is structured as { weather_patterns: { ... } } or just { Clear: ... }
    // Based on file: weather_patterns.yaml has root key 'weather_patterns'
    const patterns = weatherSource.weather_patterns || weatherSource;

    _weatherWeightSum = Object.values(patterns).reduce((sum, w) => sum + (w.weight || 0), 0);
    
    if (_weatherWeightSum > 0) {
        const rand = Math.random() * _weatherWeightSum;
        let cumulativeWeight = 0;
        for (const key in patterns) {
            const weather = patterns[key];
            cumulativeWeight += weather.weight;
            if (rand <= cumulativeWeight) {
                break;
            }
        }
    }
  }
}

export function consolidateMemories(agent, dbService, currentTick, eventBus) {
    const cutoffTick = currentTick - CONSOLIDATION_AGE_TICKS;
    const memoriesToReview = dbService.getAgentMemoriesForConsolidation(agent.id, cutoffTick);

    if (!memoriesToReview || memoriesToReview.length === 0) {
        return;
    }

    let consolidatedLog = [];
    let highSignificanceMemories = [];
    let memoryIdsToDelete = [];

    const activitySummary = new Map();
    let totalMundaneCount = 0;

    for (const memory of memoriesToReview) {
        const isHighSignificance = 
            memory.description.includes('[Life Event]') || 
            memory.description.includes('EVICTION') || 
            memory.description.includes('ARGUMENT') || 
            memory.description.includes('DATE') ||
            memory.description.includes('new partner') ||
            (memory.description.includes('I think I\'m coming down with something') && memory.tick > cutoffTick - 50);

        if (isHighSignificance) {
            highSignificanceMemories.push(memory);
        } else {
            const cleanedDescription = memory.description.substring(0, 30).trim();
            activitySummary.set(cleanedDescription, (activitySummary.get(cleanedDescription) || 0) + 1);
            totalMundaneCount++;
            memoryIdsToDelete.push(memory.memory_id);
        }
    }

    if (totalMundaneCount > 5) {
        let summary = `[CONSOLIDATED] I had a busy couple of days leading up to t${cutoffTick}. I spent time: `;
        const topActivities = Array.from(activitySummary.entries())
            .sort(([, countA], [, countB]) => countB - countA)
            .slice(0, 3);

        topActivities.forEach(([desc, count], index) => {
            summary += `${desc.replace(/I'm (.*)\. Going to .*/, '$1').toLowerCase().replace(/\./, '').trim()} (${count}x)`;
            if (index < topActivities.length - 1) summary += ', ';
        });
        
        summary += '. Overall, nothing major happened.';
        consolidatedLog.push({ description: summary, tick: cutoffTick + 1, significance: 0.1 });
    }
    
    consolidatedLog.forEach(log => {
        eventBus.queue('db:writeMemory', 'medium', agent.id, log.tick, log.description);
    });

    if (memoryIdsToDelete.length > 0) {
        dbService.deleteMemories(agent.id, memoryIdsToDelete);
        eventBus.queue('log:system', 'low', `[Memory Consolidation] ${agent.name}: Consolidated ${totalMundaneCount} low-value memories.`);
    }
}

export function updateBusinessEconomies(lod1Agents, worldNodes) {
  for (const nodeId in worldNodes) {
    const node = worldNodes[nodeId];
    if (node.is_business) {
      let currentProductivity = node.productivity * node.level;
      let currentUpkeep = node.upkeep * node.level;

      const activeWorkers = lod1Agents.filter(a =>
        a.workLocationId === nodeId && a.state.startsWith('fsm_working_')
      );

      activeWorkers.forEach(worker => {
        const skillBonus = (worker.skills?.programming ?? 0) / 20; 
        currentProductivity += (node.productivity * 0.5) + skillBonus;
      });

      node.treasury = (node.treasury ?? 0) + currentProductivity; 
      node.treasury = Math.max(0, node.treasury - currentUpkeep);
    }
  }
}

export function handlePayday(worldTime, tickCount, worldNodes, cacheManager, eventBus) {
  const day = worldTime.getDay(); // 5 = Friday
  const hour = worldTime.getHours(); // 17 = 5 PM

  if (day === 5 && hour === 17 && (tickCount % (60 / MINUTES_PER_TICK) === 0)) {
    eventBus.queue('log:info', 'high', `[Matrix] It's 5 PM on Friday. Running payroll...`);

    for (const nodeId in worldNodes) {
      const node = worldNodes[nodeId];
      if (node.is_business && node.employee_ids.length > 0) {
        for (const agentId of node.employee_ids) {
          const agent = cacheManager.getAgent(agentId);
          if (!agent) continue;
          
          const job = agent.job ?? {};
          const weeklySalary = (job.salary ?? 0) / 52;
          
          if (weeklySalary <= 0) continue; 

          if ((node.treasury ?? 0) >= weeklySalary) { 
            node.treasury -= weeklySalary;
            agent.money = (agent.money ?? 0) + weeklySalary; 
            eventBus.queue('db:writeWAL', 'medium', tickCount, 'AGENT_PAID', { agentId: agent.id, amount: weeklySalary });
          } else {
            agent.stress = Math.min(100, (agent.stress ?? 0) + 50); 
            agent.mood = Math.max(-100, (agent.mood ?? 0) - 20); 
            eventBus.queue('log:error', 'high', `[Matrix] PAYROLL FAILED for ${agent.name} at ${node.name}. (Treasury: $${(node.treasury ?? 0).toFixed(0)})`);
            eventBus.queue('db:writeMemory', 'high', agent.id, tickCount, `My paycheck bounced! ${node.name} couldn't pay me.`);
          }
        }
      }
    }
  }
}

export function handleRentDay(worldTime, tickCount, cacheManager, worldNodes, eventBus, lastRentDay) {
  const dayOfMonth = worldTime.getDate();
  const currentMonth = worldTime.getMonth();

  if (tickCount < 100) { 
      if (dayOfMonth === 1 && currentMonth === 0) {
          return currentMonth; 
      }
  }

  if (dayOfMonth === 1 && currentMonth !== lastRentDay) {
    eventBus.queue('log:info', 'high', `[Matrix] It's the 1st of the month. Rent is due!`);
    
    const allAgents = cacheManager.getAllAgents();
    for (const agent of allAgents) {
      const homeNode = agent.homeLocationId ? worldNodes[agent.homeLocationId] : null;
      
      if (homeNode && (homeNode.rent_cost ?? 0) > 0) { 
        const rent = homeNode.rent_cost;
        
        if ((agent.money ?? 0) >= rent) { 
          agent.money = (agent.money ?? 0) - rent; 
          agent.rentFailures = 0; 
          agent.status_effects = agent.status_effects.filter(e => e.type !== 'FINANCIAL_ANXIETY');
          eventBus.queue('db:writeWAL', 'medium', tickCount, 'AGENT_PAID_RENT', { agentId: agent.id, amount: rent });
          eventBus.queue('db:writeMemory', 'low', agent.id, tickCount, `Paid $${rent} for rent.`);
        
        } else {
          // --- RENT FAILED ---
          agent.stress = Math.min(100, (agent.stress ?? 0) + 80); 
          agent.mood = Math.max(-100, (agent.mood ?? 0) - 40); 
          agent.rentFailures = (agent.rentFailures ?? 0) + 1; 
          
          // Use GAME_BALANCE constants (from WORLD object)
          const anxietyDuration = GAME_BALANCE.WORLD.FINANCIAL_ANXIETY_DURATION;
          const evictionLimit = GAME_BALANCE.WORLD.EVICTION_FAILURE_COUNT;

          if (!agent.status_effects.some(e => e.type === 'FINANCIAL_ANXIETY')) {
              agent.status_effects.push({ type: 'FINANCIAL_ANXIETY', duration: anxietyDuration });
          } else {
              const anxietyEffect = agent.status_effects.find(e => e.type === 'FINANCIAL_ANXIETY');
              if (anxietyEffect) {
                  anxietyEffect.duration = anxietyDuration;
              }
          }
          
          cacheManager.updateAgent(agent); 

          if (agent.rentFailures >= evictionLimit) {
            agent.transitionToState('fsm_homeless'); 
            eventBus.queue('log:error', 'high', `[Matrix] EVICTION: ${agent.name} failed to pay rent ${evictionLimit} times. They are now HOMELESS.`);
            eventBus.queue('db:writeMemory', 'high', agent.id, tickCount, `I couldn't pay my $${rent} rent. I've failed ${evictionLimit} times... I'm homeless!`);
          
          } else {
            eventBus.queue('log:error', 'high', `[Matrix] RENT FAILED for ${agent.name}. (Needs $${rent}, has $${(agent.money ?? 0).toFixed(0)}). Failure ${agent.rentFailures} of ${evictionLimit}.`);
            eventBus.queue('db:writeMemory', 'high', agent.id, tickCount, `I couldn't pay my $${rent} rent! This is failure ${agent.rentFailures} of ${evictionLimit}.`);
          }
        }
      }
    }
    return currentMonth; 
  }
  return lastRentDay; 
}

export function updateWorldDegradation(worldNodes, locationAgentCount) {
  for (const nodeId in worldNodes) {
    const node = worldNodes[nodeId];
    if (node.condition !== undefined) {
      // Use GAME_BALANCE constants (from WORLD object)
      let degradation = GAME_BALANCE.WORLD.BASE_DEGRADATION_RATE; 
      
      const agentCount = locationAgentCount[nodeId] || 0;
      if (agentCount > 0) {
        degradation += (agentCount * GAME_BALANCE.WORLD.AGENT_DEGRADATION_MODIFIER); 
      }
      
      node.condition = Math.max(0, (node.condition ?? 100) - degradation); 
    }
  }
}

export function updateWorldState(worldTime, tickCount, worldState, eventBus) {
    const hour = worldTime.getHours();
    
    // --- Time of Day (Source: weather_patterns.yaml) ---
    const weatherData = dataLoader.weatherPatterns || dataLoader.worldData || {};
    const atmosphereData = weatherData.time_of_day_atmosphere || {};
    
    let todKey = 'night';
    if (hour >= 5 && hour < 8) todKey = 'early_morning';
    else if (hour >= 8 && hour < 12) todKey = 'morning';
    else if (hour >= 12 && hour < 17) todKey = 'afternoon';
    else if (hour >= 17 && hour < 21) todKey = 'evening';
    else if (hour >= 21 || hour < 0) todKey = 'night';
    else if (hour >= 0 && hour < 3) todKey = 'late_night';
    else if (hour >= 3 && hour < 5) todKey = 'very_late';

    worldState.timeOfDay = todKey;
    const tod = atmosphereData[todKey] || { description: '...' };
    worldState.timeOfDayDesc = tod.description;
    
    // --- Weather Update ---
    if (tickCount === 1 || tickCount % (60 * 24 / MINUTES_PER_TICK) === 0) { 
        // Use weather_patterns.yaml
        const patterns = weatherData.weather_patterns || {};
        
        let weightSum = 0;
        for(let k in patterns) weightSum += (patterns[k].weight || 0);

        if (weightSum > 0) {
            const rand = Math.random() * weightSum;
            let cumulativeWeight = 0;
            for (const key in patterns) {
                const weather = patterns[key];
                cumulativeWeight += weather.weight;
                if (rand <= cumulativeWeight) {
                    if (worldState.weather.weather !== key) {
                        worldState.weather = { ...weather, weather: key }; 
                        eventBus.queue('log:world', 'low', `[Weather] Forecast changed to: ${key}`);
                    }
                    break;
                }
            }
        }
    }

    // Apply weather effects
    const baseTemp = 18; 
    const baseLight = 0.0; 
    // Defaults for TOD light/temp if not in yaml
    const todTemp = (todKey === 'afternoon') ? 2 : (todKey === 'night' || todKey === 'late_night') ? -2 : 0;
    const todLight = (todKey === 'morning' || todKey === 'afternoon') ? 1.0 : (todKey === 'evening') ? 0.5 : 0.1;

    worldState.environment.globalTemp = baseTemp + (worldState.weather.temp || 0) + todTemp;
    worldState.environment.globalLight = Math.max(0, Math.min(1, baseLight + todLight + (worldState.weather.light || 0)));

    const weatherType = worldState.weather.weather || 'Clear';
    
    // --- News & Events Update (Source: events.yaml) ---
    const eventsData = dataLoader.events || dataLoader.eventsData || {}; 
    const newsHeadlines = eventsData.news_headlines || []; // Assuming events.yaml might have this, or fallback
    
    if (tickCount - lastNewsUpdateTick > NEWS_UPDATE_INTERVAL_TICKS) {
        let newHeadline = null;
        const contextualHeadlines = [];

        if (worldState.world_events.some(e => e.type === 'SUBWAY_DELAY')) {
            contextualHeadlines.push("Widespread subway delays plague morning commute after signal failure.");
        }
        if (worldState.world_events.some(e => e.type === 'HEAT_WAVE')) {
            contextualHeadlines.push("City issues heat advisory as temperatures soar for third straight day.");
        }
        
        if (contextualHeadlines.length > 0) {
            newHeadline = contextualHeadlines[Math.floor(Math.random() * contextualHeadlines.length)];
        }

        if (!newHeadline && newsHeadlines.length > 0) {
            newHeadline = newsHeadlines[Math.floor(Math.random() * newsHeadlines.length)];
        }
        
        // If no events.yaml headlines, keep existing or fallback
        if (worldState.news !== newHeadline && newHeadline) {
            worldState.news = newHeadline;
            lastNewsUpdateTick = tickCount;
            eventBus.queue('log:world', 'low', `[News] Headline updated: ${newHeadline}`);
        }
    }

    // --- Clean up Expired Events ---
    worldState.activeEvents = (worldState.activeEvents || []).filter(event => {
        event.ticksRemaining--;
        return event.ticksRemaining > 0;
    });
    
    worldState.world_events = (worldState.world_events || []).filter(event => {
        event.duration--;
        return event.duration > 0;
    });

    // --- Trigger Random Events (Source: events.yaml) ---
    // Check every 200 ticks (~2 days)
    if (tickCount % 200 === 0) {
        // 1. Subway Delay 
        if (Math.random() < 0.1 && !worldState.world_events.some(e => e.type === 'SUBWAY_DELAY')) {
            // Source text from events.yaml if possible
            const subEvents = eventsData.random_subway_events || [];
            const flavor = subEvents.length > 0 ? subEvents[Math.floor(Math.random() * subEvents.length)].event : "Signal Failure";
            
            const duration = Math.floor(Math.random() * 20) + 10;
            worldState.world_events.push({ type: 'SUBWAY_DELAY', duration: duration, description: flavor });
            eventBus.queue('log:world', 'medium', `SUBWAY DELAY: ${flavor} (${duration} ticks).`);
        }
        
        // 2. Heat Wave
        if (Math.random() < 0.05 && !worldState.world_events.some(e => e.type === 'HEAT_WAVE')) {
            const duration = Math.floor(Math.random() * 50) + 50;
            worldState.world_events.push({ type: 'HEAT_WAVE', duration: duration });
            eventBus.queue('log:world', 'medium', `A HEAT_WAVE is blanketing the city for ${duration} ticks.`);
        }
    }
}

export function runSensoryCheck(tickCount, worldState, playerFocus, eventBus) {
    if (tickCount % 5 !== 0 || worldState.sensoryEvent || !playerFocus) return;

    const focusedNode = worldGraph.nodes[playerFocus];
    if (!focusedNode) return;

    const hour = worldGraph.currentWorldTime.getHours();
    const weather = worldState.weather || { weather: 'Clear' };
    const crowdProfile = worldGraph.getExpectedCrowdProfile(focusedNode);
    let sensoryData = null, prefix = '';

    // Source: locations.yaml
    const locationsData = dataLoader.locations || {};
    const nycSounds = locationsData.nyc_sounds || {};
    const nycSmells = locationsData.nyc_smells || {};

    if (focusedNode.isOutdoors) {
        if (weather.weather === 'Heavy rain') {
            sensoryData = 'the roar of rain hitting the pavement.';
            prefix = 'You hear';
        } else if (weather.weather === 'Light rain' || weather.weather === 'Drizzle') {
            sensoryData = 'the gentle patter of rain.';
            prefix = 'You hear';
        } else if (weather.weather === 'Snow') {
            sensoryData = 'an unusual, muffled quiet as snow falls.';
            prefix = 'You notice';
        }
    }

    if (!sensoryData && crowdProfile.density > 0.7) {
        // High density override
        if (focusedNode.type === 'bar' || focusedNode.type === 'venue') {
            sensoryData = 'the din of a packed crowd.';
            prefix = 'You hear';
        }
    }

    if (!sensoryData) {
        const locationType = focusedNode.type;

        if (Math.random() < 0.5) {
            const sounds = nycSounds[locationType] || nycSounds['street']; 
            if (sounds && sounds.length > 0) {
                sensoryData = sounds[Math.floor(Math.random() * sounds.length)];
                prefix = 'You hear';
            }
        } else {
            const smells = nycSmells[locationType] || nycSmells['street']; 
            if (smells && smells.length > 0) {
                sensoryData = smells[Math.floor(Math.random() * smells.length)];
                prefix = 'You smell';
            }
        }
    }
    
    if (sensoryData) {
        worldState.sensoryEvent = {
            prefix: prefix,
            text: sensoryData,
            ticksRemaining: 20 
        };
        eventBus.queue('log:world', 'low', `[Atmosphere] ${prefix} ${sensoryData}.`);
    }
}