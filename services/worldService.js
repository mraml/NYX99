import worldGraph from '../data/worldGraph.js';
import { 
  MINUTES_PER_TICK,
  // REMOVED: FINANCIAL_ANXIETY_DURATION, EVICTION_FAILURE_COUNT, BASE_DEGRADATION_RATE, AGENT_DEGRADATION_MODIFIER
  // These are now in GAME_BALANCE.WORLD
} from '../data/config.js';
import { dataLoader } from '../data/dataLoader.js';
import { GAME_BALANCE } from '../data/balance.js'; 

/**
 * services/worldService.js
 *
 * Handles all "idle game" logic for the persistent world,
 * including business economies, rent, and degradation.
 * (REFACTORED v9.24: Fixed imports to use GAME_BALANCE fully.)
 */

const CONSOLIDATION_AGE_TICKS = 192; 
let lastNewsUpdateTick = 0;
const NEWS_UPDATE_INTERVAL_TICKS = 60; 

let _weatherWeightSum = 0;

export function initWorldService() {
  if (dataLoader.worldData && dataLoader.worldData.weather_patterns) {
    _weatherWeightSum = Object.values(dataLoader.worldData.weather_patterns).reduce((sum, w) => sum + (w.weight || 0), 0);
    
    const weatherPatterns = dataLoader.worldData.weather_patterns || {};
    if (_weatherWeightSum > 0) {
        const rand = Math.random() * _weatherWeightSum;
        let cumulativeWeight = 0;
        for (const key in weatherPatterns) {
            const weather = weatherPatterns[key];
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
    
    const timeData = dataLoader.worldData.time_of_day_data || {};
    const todKey = Object.keys(timeData).reverse().find(k => hour >= k) || '12'; 
    const tod = timeData[todKey] || { key: 'afternoon', descriptions: ['...'], light: 1.0, temp: 2 };
    
    worldState.timeOfDay = tod.key;
    
    if (Array.isArray(tod.descriptions) && tod.descriptions.length > 0) {
        worldState.timeOfDayDesc = tod.descriptions[Math.floor(Math.random() * tod.descriptions.length)];
    } else {
        worldState.timeOfDayDesc = tod.descriptions || tod.desc || '...'; 
    }
    
    if (tickCount === 1 || tickCount % (60 * 24 / MINUTES_PER_TICK) === 0) { 
        const weatherPatterns = dataLoader.worldData.weather_patterns || {};
        if (_weatherWeightSum > 0) {
            const rand = Math.random() * _weatherWeightSum;
            let cumulativeWeight = 0;
            for (const key in weatherPatterns) {
                const weather = weatherPatterns[key];
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

    const baseTemp = 18; 
    const baseLight = 0.0; 
    worldState.environment.globalTemp = baseTemp + (worldState.weather.temp || 0) + tod.temp;
    worldState.environment.globalLight = Math.max(0, Math.min(1, baseLight + tod.light + (worldState.weather.light || 0)));

    const weatherType = worldState.weather.weather || 'Clear';
    if (weatherType === 'Heavy rain') {
        worldState.timeOfDayDesc = 'The city is drenched in a downpour.';
    } else if (weatherType === 'Snow') {
        worldState.timeOfDayDesc = 'A blanket of snow quietly covers the streets.';
    } else if (weatherType === 'Hot and humid') {
        worldState.timeOfDayDesc = 'The air is thick and heavy with oppressive humidity.';
    }

    const newsHeadlines = dataLoader.worldData.news_headlines || [];
    if (tickCount - lastNewsUpdateTick > NEWS_UPDATE_INTERVAL_TICKS) {
        let newHeadline = null;
        const contextualHeadlines = [];

        if (worldState.world_events.some(e => e.type === 'SUBWAY_DELAY')) {
            contextualHeadlines.push("Widespread subway delays plague morning commute after signal failure.");
        }
        if (worldState.world_events.some(e => e.type === 'HEAT_WAVE')) {
            contextualHeadlines.push("City issues heat advisory as temperatures soar for third straight day.");
        }
        
        if (weatherType === 'Snow' && !worldState.news.includes('Snow')) {
            contextualHeadlines.push("First major snowfall of the season expected, city deploys salt trucks.");
        }
        if (weatherType === 'Heavy rain' && !worldState.news.includes('Flooding')) {
            contextualHeadlines.push("Flash flood warnings issued for low-lying areas in Brooklyn and Queens.");
        }

        if (contextualHeadlines.length > 0) {
            newHeadline = contextualHeadlines[Math.floor(Math.random() * contextualHeadlines.length)];
        }

        if (!newHeadline && newsHeadlines.length > 0) {
            newHeadline = newsHeadlines[Math.floor(Math.random() * newsHeadlines.length)];
        }
        
        if (worldState.news !== newHeadline) {
            worldState.news = newHeadline;
            lastNewsUpdateTick = tickCount;
            eventBus.queue('log:world', 'low', `[News] Headline updated: ${newHeadline}`);
        }
    }

    worldState.activeEvents = (worldState.activeEvents || []).filter(event => {
        event.ticksRemaining--;
        return event.ticksRemaining > 0;
    });
    
    const randomSubwayEvents = dataLoader.worldData?.random_subway_events || [];
    if (Math.random() < 1 / 75 && (worldState.activeEvents || []).length < 3 && randomSubwayEvents.length > 0) {
        const eventTemplate = randomSubwayEvents[Math.floor(Math.random() * randomSubwayEvents.length)];
        const newEvent = { name: eventTemplate.event, ticksRemaining: Math.floor(Math.random() * 50) + 50 };
        worldState.activeEvents.push(newEvent);
        eventBus.queue('log:world', 'low', `${newEvent.name}`);
    }

    if (worldState.sensoryEvent) {
        worldState.sensoryEvent.ticksRemaining--;
        if (worldState.sensoryEvent.ticksRemaining <= 0) {
            worldState.sensoryEvent = null;
        }
    }

    worldState.world_events = (worldState.world_events || []).filter(event => {
        event.duration--;
        return event.duration > 0;
    });

    if (tickCount % 200 === 0) {
        if (Math.random() < 0.1 && !worldState.world_events.some(e => e.type === 'SUBWAY_DELAY')) {
            const duration = Math.floor(Math.random() * 20) + 10;
            worldState.world_events.push({ type: 'SUBWAY_DELAY', duration: duration });
            eventBus.queue('log:world', 'medium', `A SUBWAY_DELAY is affecting commutes for ${duration} ticks.`);
        }
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
        if (focusedNode.type === 'bar' || focusedNode.type === 'venue') {
            sensoryData = 'the din of a packed crowd and loud music.';
            prefix = 'You hear';
        } else if (focusedNode.type === 'restaurant' || focusedNode.type === 'park') {
            sensoryData = 'the murmur of many conversations.';
            prefix = 'You hear';
        }
    }

    if (!sensoryData && hour >= 2 && hour < 5 && focusedNode.isOutdoors) {
        const nightSounds = [
            'a distant siren wailing.',
            'the rumble of an idling truck.',
            'a far-off shout, quickly silenced.'
        ];
        sensoryData = nightSounds[Math.floor(Math.random() * nightSounds.length)];
        prefix = 'In the quiet, you hear';
    }
    
    if (!sensoryData) {
        const nycSounds = dataLoader.worldData?.nyc_sounds || {};
        const nycSmells = dataLoader.worldData?.nyc_smells || {};
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