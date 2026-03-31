import crypto from 'crypto';
import { GAME_BALANCE } from '../data/balance.js';
import { TARGET_POPULATION, LIFECYCLE_CHECK_INTERVAL_TICKS } from '../data/config.js';
import { dataLoader } from '../data/dataLoader.js';
import {
  computeAge,
  computeLifeStage,
  computeBirthDate,
  generateSex,
  generateNameWithFamily,
  generateRandomName,
  generateRandomJob,
  getLastName,
} from '../engine/agentUtilities.js';
import { driftOpinion, assignPoliticsToNewAgent } from './politicsService.js';
import { getPolicyMultipliers } from './worldService.js';
import logger from '../logger.js';

const LC = GAME_BALANCE.LIFECYCLE;
const TICKS_PER_DAY = 96;

let _lastLifecycleTick = -TICKS_PER_DAY;

export function runLifecycleTick(tickCount, worldTime, cacheManager, eventBus) {
  if (tickCount - _lastLifecycleTick < LIFECYCLE_CHECK_INTERVAL_TICKS) return;
  _lastLifecycleTick = tickCount;

  const allAgents = cacheManager.getAllAgents().filter(a => a.isAlive !== false);

  updateAges(allAgents, worldTime, eventBus, cacheManager);
  processNaturalDeath(allAgents, worldTime, cacheManager, eventBus);
  processAccidentsAndIllness(allAgents, cacheManager, eventBus);
  processPregnancyAndBirth(allAgents, worldTime, tickCount, cacheManager, eventBus);
  processMarriage(allAgents, cacheManager, eventBus);
  processDivorce(allAgents, cacheManager, eventBus);
  processEmigration(allAgents, cacheManager, eventBus);
  processImmigration(tickCount, worldTime, cacheManager, eventBus);
}

// --- Aging ---
function updateAges(agents, worldTime, eventBus, cacheManager) {
  for (const agent of agents) {
    const oldStage = agent.lifeStage;
    agent.updateAge(worldTime);
    const newStage = agent.lifeStage;

    if (oldStage !== newStage) {
      onLifeStageTransition(agent, oldStage, newStage, cacheManager, eventBus);
    }
  }
}

function onLifeStageTransition(agent, oldStage, newStage, cacheManager, eventBus) {
  const demographics = dataLoader.demographics;

  if (oldStage === 'child' && newStage === 'teen') {
    agent.shortTermMemory.push({ text: 'I just became a teenager.', valence: 3 });
    logger.info(`[Lifecycle] ${agent.name} became a teenager (age ${agent.age})`);
  }

  if (oldStage === 'teen' && newStage === 'adult') {
    if (!agent.job || agent.job.title === 'Unemployed') {
      if (demographics?.jobs) {
        agent.job = generateRandomJob(demographics);
        agent.workStartHour = agent.job.hours?.[0] ?? 9;
        agent.workEndHour = agent.job.hours?.[1] ?? 17;
      }
    }
    assignPoliticsToNewAgent(agent);
    agent.shortTermMemory.push({ text: 'I turned 18. Time to figure out my life.', valence: 5 });
    logger.info(`[Lifecycle] ${agent.name} became an adult (age ${agent.age})`);
  }

  if (oldStage === 'adult' && newStage === 'elder') {
    agent.job = { title: 'Retired', salary: 0, hours: [9, 17] };
    driftOpinion(agent, 'crime_policing', 10);
    driftOpinion(agent, 'quality_of_life', 8);
    agent.politicalEngagement = Math.min(100, (agent.politicalEngagement || 0) + GAME_BALANCE.POLITICS.ENGAGEMENT_AGE_ELDER_BONUS);
    agent.shortTermMemory.push({ text: 'I retired. Time to take it easy.', valence: 2 });
    logger.info(`[Lifecycle] ${agent.name} retired (age ${agent.age})`);
  }

  eventBus.emitNow('agent:lifeStageChanged', {
    agentId: agent.id,
    name: agent.name,
    oldStage,
    newStage,
    age: agent.age,
  });
}

// --- Natural Death ---
function processNaturalDeath(agents, worldTime, cacheManager, eventBus) {
  const toRemove = [];

  for (const agent of agents) {
    const rate = getMortalityRate(agent.age);
    if (Math.random() < rate) {
      toRemove.push(agent);
    }
  }

  for (const agent of toRemove) {
    executeDeathPipeline(agent, 'natural causes', cacheManager, eventBus);
  }
}

function getMortalityRate(age) {
  for (const bracket of LC.MORTALITY_RATES) {
    if (age >= bracket.minAge && age <= bracket.maxAge) {
      return bracket.dailyChance;
    }
  }
  return 0.01;
}

function executeDeathPipeline(agent, cause, cacheManager, eventBus) {
  agent.causeOfDeath = cause;

  if (agent.spouseId) {
    const spouse = cacheManager.getAgent(agent.spouseId);
    if (spouse) {
      spouse.spouseId = null;
      spouse.shortTermMemory.push({
        text: `[Life Event] My spouse ${agent.name} passed away from ${cause}.`,
        valence: -20,
      });
      if (agent.money > 0) {
        spouse.money += agent.money;
        agent.money = 0;
      }
    }
  } else if (agent.childIds && agent.childIds.length > 0) {
    const eldest = cacheManager.getAgent(agent.childIds[0]);
    if (eldest && agent.money > 0) {
      eldest.money += agent.money;
      agent.money = 0;
    }
  }

  const relIds = Object.keys(agent.relationships || {});
  for (const relId of relIds) {
    const other = cacheManager.getAgent(relId);
    if (other) {
      const rel = other.getRelationship(agent.id);
      if (rel.affinity > 20) {
        other.shortTermMemory.push({
          text: `[Life Event] ${agent.name} passed away.`,
          valence: -Math.min(10, Math.floor(rel.affinity / 10)),
        });
      }
    }
  }

  eventBus.emitNow('agent:died', {
    agentId: agent.id,
    name: agent.name,
    age: agent.age,
    cause,
  });

  logger.info(`[Lifecycle] ${agent.name} (age ${agent.age}) died of ${cause}`);
  cacheManager.removeAgent(agent.id, 'death');
}

// --- Accidents & Illness ---
function processAccidentsAndIllness(agents, cacheManager, eventBus) {
  const demographics = dataLoader.demographics;
  const lifeEvents = demographics?.life_events;
  if (!lifeEvents) return;

  const accidents = lifeEvents.accidents || [];
  const illnesses = lifeEvents.illnesses || [];

  for (const agent of agents) {
    if (agent.status_effects?.some(e => e.type === 'INJURED' || e.type === 'SICK')) continue;

    const policyMults = getPolicyMultipliers();
    for (const accident of accidents) {
      const chance = accident.type === 'mugging'
        ? accident.chance_per_day * policyMults.crime
        : accident.chance_per_day;
      if (Math.random() < chance) {
        if (Math.random() < accident.mortality) {
          executeDeathPipeline(agent, accident.description, cacheManager, eventBus);
          break;
        }
        agent.status_effects.push({
          type: 'INJURED',
          description: accident.description,
          duration: TICKS_PER_DAY * 3,
          magnitude: 0.5,
          affectedStats: ['energy_decay'],
        });
        agent.shortTermMemory.push({
          text: `[Life Event] I ${accident.description}.`,
          valence: -8,
        });
        agent.stress = Math.min(100, agent.stress + 20);
        eventBus.emitNow('agent:accident', {
          agentId: agent.id,
          name: agent.name,
          type: accident.type,
        });
        if (accident.type === 'mugging') {
          driftOpinion(agent, 'crime_policing', GAME_BALANCE.POLITICS.OPINION_DRIFT_MUGGED);
          driftOpinion(agent, 'quality_of_life', GAME_BALANCE.POLITICS.OPINION_DRIFT_MUGGED * 0.5);
        }
        break;
      }
    }

    if (!cacheManager.getAgent(agent.id)) continue;

    const elderMult = agent.lifeStage === 'elder' ? LC.ELDER_ILLNESS_MULTIPLIER : 1.0;

    for (const illness of illnesses) {
      if (Math.random() < illness.chance_per_day * elderMult) {
        if (illness.mortality > 0 && Math.random() < illness.mortality * elderMult) {
          executeDeathPipeline(agent, illness.description, cacheManager, eventBus);
          break;
        }
        const durationTicks = (illness.duration_days || 3) * TICKS_PER_DAY;
        agent.status_effects.push({
          type: 'SICK',
          description: illness.description,
          duration: durationTicks,
          magnitude: 1.3,
          affectedStats: ['energy_decay', 'hunger_decay'],
        });
        agent.shortTermMemory.push({
          text: `I ${illness.description}.`,
          valence: -5,
        });
        eventBus.emitNow('agent:illness', {
          agentId: agent.id,
          name: agent.name,
          type: illness.type,
        });
        break;
      }
    }
  }
}

// --- Pregnancy & Birth ---
function processPregnancyAndBirth(agents, worldTime, currentTick, cacheManager, eventBus) {
  for (const agent of agents) {
    if (agent.sex !== 'female' || agent.lifeStage !== 'adult') continue;

    const isPregnant = agent.status_effects?.some(e => e.type === 'PREGNANT');

    if (isPregnant) {
      const pregEffect = agent.status_effects.find(e => e.type === 'PREGNANT');
      if (pregEffect && pregEffect.duration <= 0) {
        giveBirth(agent, worldTime, currentTick, cacheManager, eventBus);
      }
      continue;
    }

    const partnerId = agent.spouseId || agent.partnerId;
    if (!partnerId) continue;
    const partner = cacheManager.getAgent(partnerId);
    if (!partner || partner.sex === agent.sex) continue;

    const rel = agent.getRelationship(partnerId);
    if (rel.affinity < 60) continue;

    let chance = LC.PREGNANCY_BASE_CHANCE;
    if (agent.age > LC.PREGNANCY_AGE_PENALTY_START) {
      chance *= Math.max(0.1, 1 - (agent.age - LC.PREGNANCY_AGE_PENALTY_START) * 0.05);
    }
    if (agent.age >= LC.PREGNANCY_MAX_AGE) continue;

    const existingChildren = (agent.childIds || []).length;
    if (existingChildren >= LC.MAX_CHILDREN_PENALTY) {
      chance *= 0.3;
    }

    if (agent.money < 500) chance *= 0.5;

    if (Math.random() < chance) {
      const durationTicks = LC.PREGNANCY_DURATION_DAYS * TICKS_PER_DAY;
      agent.status_effects.push({
        type: 'PREGNANT',
        description: 'pregnant',
        duration: durationTicks,
        magnitude: 1.2,
        affectedStats: ['energy_decay'],
      });
      agent.shortTermMemory.push({
        text: `[Life Event] I found out I'm pregnant!`,
        valence: 10,
      });
      if (partner) {
        partner.shortTermMemory.push({
          text: `[Life Event] ${agent.name} told me we're having a baby!`,
          valence: 10,
        });
      }
      eventBus.emitNow('agent:pregnant', {
        agentId: agent.id,
        name: agent.name,
        partnerId,
      });
      logger.info(`[Lifecycle] ${agent.name} is pregnant`);
    }
  }
}

function giveBirth(mother, worldTime, currentTick, cacheManager, eventBus) {
  const demographics = dataLoader.demographics;
  const childSex = generateSex();
  const familyLastName = getLastName(mother.name);
  const childName = demographics
    ? generateNameWithFamily(demographics, childSex, familyLastName)
    : `Baby ${familyLastName}`;

  const fatherId = mother.spouseId || mother.partnerId;

  const childData = {
    sex: childSex,
    birthDate: worldTime.toISOString(),
    age: 0,
    isAlive: true,
    familyId: mother.familyId,
    parentIds: [mother.id, fatherId].filter(Boolean),
    childIds: [],
    name: childName,
    homeLocationId: mother.homeLocationId,
    locationId: mother.homeLocationId,
    rent_cost: 0,
    money: 0,
    state: 'fsm_idle',
  };

  const child = cacheManager.createSingleAgent(childData, currentTick);

  mother.childIds = mother.childIds || [];
  mother.childIds.push(child.id);
  mother.updateRelationship(child.id, 80, 'child', {
    event: 'birth',
    description: `Gave birth to ${childName}`,
  });

  child.updateRelationship(mother.id, 80, 'parent');

  if (fatherId) {
    const father = cacheManager.getAgent(fatherId);
    if (father) {
      father.childIds = father.childIds || [];
      father.childIds.push(child.id);
      father.updateRelationship(child.id, 80, 'child', {
        event: 'birth',
        description: `Had a child: ${childName}`,
      });
      child.updateRelationship(father.id, 80, 'parent');
      father.shortTermMemory.push({
        text: `[Life Event] Our baby ${childName} was born!`,
        valence: 15,
      });
    }
  }

  // Sibling relationships
  for (const sibId of mother.childIds) {
    if (sibId === child.id) continue;
    const sibling = cacheManager.getAgent(sibId);
    if (sibling) {
      sibling.updateRelationship(child.id, 50, 'sibling');
      child.updateRelationship(sibId, 50, 'sibling');
    }
  }

  mother.shortTermMemory.push({
    text: `[Life Event] I gave birth to ${childName}!`,
    valence: 15,
  });

  mother.status_effects = (mother.status_effects || []).filter(e => e.type !== 'PREGNANT');

  cacheManager.lifecycleStats.totalBirths++;

  eventBus.emitNow('agent:born', {
    childId: child.id,
    childName,
    motherId: mother.id,
    fatherId,
  });

  logger.info(`[Lifecycle] ${childName} was born to ${mother.name}`);
}

// --- Marriage ---
function processMarriage(agents, cacheManager, eventBus) {
  const processed = new Set();

  for (const agent of agents) {
    if (agent.spouseId || agent.lifeStage !== 'adult' || processed.has(agent.id)) continue;
    if (!agent.partnerId) continue;

    const partner = cacheManager.getAgent(agent.partnerId);
    if (!partner || partner.spouseId || partner.lifeStage !== 'adult') continue;
    if (processed.has(partner.id)) continue;

    const rel = agent.getRelationship(partner.id);
    if (rel.affinity < LC.MARRIAGE_AFFINITY_THRESHOLD) continue;

    if (Math.random() > 0.02) continue;

    agent.spouseId = partner.id;
    partner.spouseId = agent.id;
    agent.partnerId = null;
    partner.partnerId = null;

    agent.updateRelationship(partner.id, 10, 'spouse', {
      event: 'marriage',
      description: `Married ${partner.name}`,
    });
    partner.updateRelationship(agent.id, 10, 'spouse', {
      event: 'marriage',
      description: `Married ${agent.name}`,
    });

    if (partner.homeLocationId !== agent.homeLocationId) {
      partner.homeLocationId = agent.homeLocationId;
      partner.rent_cost = 0;
    }

    agent.shortTermMemory.push({
      text: `[Life Event] I married ${partner.name}!`,
      valence: 20,
    });
    partner.shortTermMemory.push({
      text: `[Life Event] I married ${agent.name}!`,
      valence: 20,
    });

    processed.add(agent.id);
    processed.add(partner.id);

    eventBus.emitNow('agent:married', {
      agent1Id: agent.id,
      agent2Id: partner.id,
      names: `${agent.name} & ${partner.name}`,
    });

    logger.info(`[Lifecycle] ${agent.name} and ${partner.name} got married`);
  }
}

// --- Divorce ---
function processDivorce(agents, cacheManager, eventBus) {
  for (const agent of agents) {
    if (!agent.spouseId) continue;

    const spouse = cacheManager.getAgent(agent.spouseId);
    if (!spouse) {
      agent.spouseId = null;
      continue;
    }

    const rel = agent.getRelationship(spouse.id);
    if (rel.affinity > LC.DIVORCE_AFFINITY_THRESHOLD) continue;
    if (agent.stress < LC.DIVORCE_STRESS_THRESHOLD) continue;

    if (Math.random() > LC.DIVORCE_BASE_CHANCE) continue;

    const oldSpouseId = agent.spouseId;
    agent.spouseId = null;
    spouse.spouseId = null;

    agent.updateRelationship(oldSpouseId, -20, 'ex-spouse', {
      event: 'divorce',
      description: `Divorced ${spouse.name}`,
    });
    spouse.updateRelationship(agent.id, -20, 'ex-spouse', {
      event: 'divorce',
      description: `Divorced ${agent.name}`,
    });

    spouse.ensureHome();

    agent.shortTermMemory.push({
      text: `[Life Event] I divorced ${spouse.name}.`,
      valence: -15,
    });
    spouse.shortTermMemory.push({
      text: `[Life Event] I divorced ${agent.name}.`,
      valence: -15,
    });

    eventBus.emitNow('agent:divorced', {
      agent1Id: agent.id,
      agent2Id: oldSpouseId,
    });

    logger.info(`[Lifecycle] ${agent.name} and ${spouse.name} divorced`);
  }
}

// --- Emigration ---
function processEmigration(agents, cacheManager, eventBus) {
  for (const agent of agents) {
    if (agent.lifeStage === 'child') continue;
    if (agent.isMetasim) continue;

    let chance = 0;
    if (agent.rentFailures > LC.EMIGRATION_RENT_FAILURE_THRESHOLD) {
      chance += LC.EMIGRATION_BASE_CHANCE * 2;
    }
    if (agent.money < -500) {
      chance += LC.EMIGRATION_BASE_CHANCE;
    }
    if (agent.mood < LC.EMIGRATION_MOOD_THRESHOLD) {
      chance += LC.EMIGRATION_BASE_CHANCE;
    }

    if (chance <= 0) continue;
    if (Math.random() > chance) continue;

    eventBus.emitNow('agent:emigrated', {
      agentId: agent.id,
      name: agent.name,
      age: agent.age,
    });

    logger.info(`[Lifecycle] ${agent.name} (age ${agent.age}) moved away from NYC`);

    // Take dependent children with them
    if (agent.childIds) {
      for (const childId of agent.childIds) {
        const child = cacheManager.getAgent(childId);
        if (child && (child.lifeStage === 'child' || child.lifeStage === 'teen')) {
          cacheManager.removeAgent(childId, 'emigration');
        }
      }
    }

    cacheManager.removeAgent(agent.id, 'emigration');
  }
}

// --- Immigration ---
function processImmigration(currentTick, worldTime, cacheManager, eventBus) {
  const currentPop = cacheManager.getPopulationCount();
  if (currentPop >= TARGET_POPULATION) return;

  const numNew = Math.min(LC.IMMIGRATION_RATE, TARGET_POPULATION - currentPop);

  for (let i = 0; i < numNew; i++) {
    const age = 18 + Math.floor(Math.random() * 35);
    const sex = generateSex();
    const demographics = dataLoader.demographics;

    const data = {
      sex,
      age,
      birthDate: computeBirthDate(age, worldTime).toISOString(),
      isAlive: true,
      state: 'fsm_idle',
    };

    const agent = cacheManager.createSingleAgent(data, currentTick);
    agent.shortTermMemory.push({
      text: 'Just moved to NYC. Everything is new and exciting.',
      valence: 5,
    });

    assignPoliticsToNewAgent(agent);

    cacheManager.lifecycleStats.totalImmigrations++;

    eventBus.emitNow('agent:immigrated', {
      agentId: agent.id,
      name: agent.name,
      age: agent.age,
    });

    logger.info(`[Lifecycle] ${agent.name} (age ${agent.age}) moved to NYC`);
  }
}
