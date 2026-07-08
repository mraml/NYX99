import { GAME_BALANCE } from '../data/balance.js';
import { POLITICS_DATA } from '../data/dataLoader.js';
import { generatePoliticalProfile } from '../engine/agentUtilities.js';
import eventBus from '../engine/eventBus.js';

const POL = GAME_BALANCE.POLITICS;
const TICKS_PER_DAY = 96;

// Internal state
let _officeholders = {};      // officeId -> { name, agentId, party, positions, approval, termStart }
let _elections = {};           // officeId -> election state object
let _electionPhase = 'none';  // 'none' | 'campaign' | 'primary' | 'election_day' | 'transition'
let _termStartTick = 0;
let _lastPoliticsCheckTick = 0;
let _politicalNews = [];
let _recentEvents = [];
let _cacheManager = null;
let _initialized = false;
let _lastTimedEventTick = {};

export function initPoliticsService(cacheManager) {
  _cacheManager = cacheManager;

  const initialData = POLITICS_DATA.initial_officeholders;
  const offices = POLITICS_DATA.offices || [];

  for (const office of offices) {
    const seed = initialData?.[office.id];
    if (seed) {
      _officeholders[office.id] = {
        name: seed.name,
        agentId: null,
        party: seed.party,
        positions: { ...seed.positions },
        approval: seed.approval ?? 50,
        termStart: 0,
      };
    }
  }

  _termStartTick = 0;
  _electionPhase = 'none';
  _elections = {};
  _politicalNews = [];
  _recentEvents = [];

  _assignPoliticsToAllAgents(cacheManager);
  _initialized = true;

  eventBus.emitNow('log:world', '[Politics] Political system initialized. It\'s 1999 in New York City.');
}

function _assignPoliticsToAllAgents(cacheManager) {
  const agentIds = cacheManager.getAllAgentIds();
  let assigned = 0;

  for (const id of agentIds) {
    const agent = cacheManager.getAgent(id);
    if (!agent || agent.politicalParty) continue;

    const profile = generatePoliticalProfile(agent);
    agent.politicalParty = profile.party;
    agent.politicalOpinions = profile.opinions;
    agent.politicalEngagement = profile.engagement;
    assigned++;
  }

  eventBus.emitNow('log:info', `[Politics] Assigned political profiles to ${assigned} agents.`);
}

export function runPoliticsTick(tickCount, worldTime, worldState, cacheManager, _eventBus) {
  if (!_initialized) return;
  if (tickCount - _lastPoliticsCheckTick < POL.ELECTION_CHECK_INTERVAL_TICKS) return;
  _lastPoliticsCheckTick = tickCount;

  const daysSinceTermStart = Math.floor((tickCount - _termStartTick) / TICKS_PER_DAY);
  const termLength = POL.TERM_LENGTH_DAYS;
  const campaignStart = termLength - POL.CAMPAIGN_SEASON_DAYS;
  const primaryDay = termLength - POL.PRIMARY_DAYS_BEFORE_GENERAL;
  const electionDay = termLength;

  _updateApprovalRatings(cacheManager, worldState);
  _passiveOpinionDrift(cacheManager);
  _processTimedEvents(tickCount, worldTime, cacheManager, worldState);

  if (_electionPhase === 'none' && daysSinceTermStart >= campaignStart) {
    _beginCampaignSeason(tickCount, cacheManager, worldState);
  } else if (_electionPhase === 'campaign') {
    _runCampaignTick(tickCount, worldTime, cacheManager, worldState);
    if (daysSinceTermStart >= primaryDay) {
      _runPrimary(tickCount, cacheManager);
    }
  } else if (_electionPhase === 'primary' && daysSinceTermStart >= electionDay) {
    _runGeneralElection(tickCount, cacheManager, worldState);
  } else if (_electionPhase === 'transition') {
    _inaugurate(tickCount, cacheManager);
  }
}

function _updateApprovalRatings(cacheManager, worldState) {
  for (const officeId in _officeholders) {
    const holder = _officeholders[officeId];
    const decayRange = POL.APPROVAL_DECAY_RATE * 20;
    holder.approval += (Math.random() * decayRange * 2) - decayRange;

    if (officeId === 'mayor' && worldState?.economy === 'recession') {
      holder.approval -= 1;
    }

    holder.approval = Math.max(5, Math.min(95, holder.approval));
  }
}

function _processTimedEvents(tickCount, worldTime, cacheManager, worldState) {
  const timedEvents = POLITICS_DATA.timed_events;
  if (!timedEvents || !worldTime) return;

  const month = worldTime.getMonth();
  const day = worldTime.getDate();

  for (const evt of timedEvents) {
    let monthMatch = false;
    if (evt.month !== undefined) {
      monthMatch = month === evt.month;
    } else if (evt.month_range) {
      monthMatch = month >= evt.month_range[0] && month <= evt.month_range[1];
    }
    if (!monthMatch) continue;

    if (evt.day_range && (day < evt.day_range[0] || day > evt.day_range[1])) continue;

    const intervalTicks = (evt.interval_days || 7) * TICKS_PER_DAY;
    const lastFired = _lastTimedEventTick[evt.id] || 0;
    if (tickCount - lastFired < intervalTicks) continue;

    _lastTimedEventTick[evt.id] = tickCount;

    const headlines = evt.headlines || [];
    if (headlines.length === 0) continue;

    const headline = headlines[Math.floor(Math.random() * headlines.length)];
    _addPoliticalNews(headline);
    eventBus.emitNow('log:world', `[Politics] ${headline}`);

    if (evt.opinion_drift && evt.opinion_drift.issue) {
      const agentIds = cacheManager.getAllAgentIds();
      const sampleSize = Math.min(80, agentIds.length);
      for (let i = 0; i < sampleSize; i++) {
        const id = agentIds[Math.floor(Math.random() * agentIds.length)];
        const agent = cacheManager.getAgent(id);
        if (!agent || !agent.politicalOpinions) continue;

        let amount = evt.opinion_drift.amount || 0;
        if (evt.opinion_drift.borough_boost) {
          const agentBorough = _getBoroughFromLocation(agent.homeLocationId);
          const boost = evt.opinion_drift.borough_boost[agentBorough];
          if (boost) amount += boost;
        }
        driftOpinion(agent, evt.opinion_drift.issue, amount);
      }
    }
  }
}

function _passiveOpinionDrift(cacheManager) {
  const parties = POLITICS_DATA.parties || [];
  const partyBaseMap = {};
  for (const p of parties) partyBaseMap[p.id] = p.base_positions || {};

  const agentIds = cacheManager.getAllAgentIds();
  const sampleSize = Math.min(50, agentIds.length);
  for (let i = 0; i < sampleSize; i++) {
    const id = agentIds[Math.floor(Math.random() * agentIds.length)];
    const agent = cacheManager.getAgent(id);
    if (!agent || !agent.politicalOpinions || !agent.politicalParty) continue;

    const base = partyBaseMap[agent.politicalParty];
    if (!base) continue;

    for (const issue in agent.politicalOpinions) {
      const current = agent.politicalOpinions[issue];
      const target = base[issue] || 0;
      if (Math.abs(current - target) > 5) {
        const direction = target > current ? 1 : -1;
        agent.politicalOpinions[issue] = Math.max(-100, Math.min(100,
          current + direction * POL.OPINION_DRIFT_RATE
        ));
      }
    }
  }
}

function _beginCampaignSeason(tickCount, cacheManager, worldState) {
  _electionPhase = 'campaign';
  _elections = {};

  const offices = POLITICS_DATA.offices || [];
  for (const office of offices) {
    const candidates = _selectCandidates(office, cacheManager);
    _elections[office.id] = {
      office,
      candidates,
      phase: 'campaign',
      events: [],
    };
  }

  const headline = 'Campaign season begins! Candidates declare for citywide and borough offices.';
  _addPoliticalNews(headline);
  eventBus.emitNow('log:world', `[Politics] ${headline}`);
  _emitPoliticsEvent('politics:electionAnnounced', { tick: tickCount });
}

function _selectCandidates(office, cacheManager) {
  const candidates = [];
  const incumbent = _officeholders[office.id];

  // Incumbent runs for re-election (75% chance)
  if (incumbent && Math.random() < 0.75) {
    candidates.push({
      name: incumbent.name,
      agentId: incumbent.agentId,
      party: incumbent.party,
      positions: { ...incumbent.positions },
      charisma: 50 + Math.floor(Math.random() * 30),
      isIncumbent: true,
      voteCount: 0,
    });
  }

  const agentIds = cacheManager.getAllAgentIds();
  const eligibleJobs = new Set(POL.CANDIDATE_ELIGIBLE_JOBS);
  const targetCount = POL.MIN_CANDIDATES_PER_RACE + Math.floor(Math.random() * (POL.MAX_CANDIDATES_PER_RACE - POL.MIN_CANDIDATES_PER_RACE + 1));

  const shuffled = [...agentIds].sort(() => Math.random() - 0.5);

  for (const id of shuffled) {
    if (candidates.length >= targetCount) break;

    const agent = cacheManager.getAgent(id);
    if (!agent) continue;
    if (!agent.isAlive || agent.isAlive === 0) continue;
    if (agent.age < POL.CANDIDATE_MIN_AGE) continue;
    if (agent.lifeStage === 'child' || agent.lifeStage === 'teen') continue;
    if (agent.stress > 80) continue;
    if (!agent.homeLocationId) continue;
    if (agent.politicalOffice && agent.politicalOffice !== 'none') continue;

    // Borough scope check
    if (office.scope !== 'citywide') {
      const borough = _getBoroughFromLocation(agent.homeLocationId);
      if (borough !== office.scope) continue;
    }

    // Weight toward relevant jobs and high social agents
    let weight = 1;
    if (eligibleJobs.has(agent.job?.title)) weight *= POL.CANDIDATE_WEIGHT_RELEVANT_JOB;
    const socialRelCount = Object.keys(agent.relationships || {}).length;
    if (socialRelCount > 5) weight *= POL.CANDIDATE_WEIGHT_HIGH_SOCIAL;

    if (Math.random() > (1 / weight)) continue;

    // Already a candidate for another race?
    if (candidates.find(c => c.agentId === agent.id)) continue;

    const opinions = agent.politicalOpinions || { crime_policing: 0, development: 0, rent_housing: 0, transit: 0, quality_of_life: 0 };
    candidates.push({
      name: agent.name,
      agentId: agent.id,
      party: agent.politicalParty || 'independent',
      positions: { ...opinions },
      charisma: 30 + Math.floor(Math.random() * 50) + (socialRelCount > 8 ? 15 : 0),
      isIncumbent: false,
      voteCount: 0,
    });

    agent.politicalOffice = `candidate_for_${office.id}`;
  }

  // Ensure minimum candidates with generated NPCs if needed
  while (candidates.length < POL.MIN_CANDIDATES_PER_RACE) {
    const parties = POLITICS_DATA.parties || [];
    const party = parties[Math.floor(Math.random() * parties.length)];
    candidates.push({
      name: _generateCandidateName(),
      agentId: null,
      party: party.id,
      positions: { ...party.base_positions },
      charisma: 30 + Math.floor(Math.random() * 40),
      isIncumbent: false,
      voteCount: 0,
    });
  }

  for (const c of candidates) {
    _emitPoliticsEvent('politics:candidateDeclared', { name: c.name, office: office.title, party: c.party });
  }

  return candidates;
}

function _runCampaignTick(tickCount, worldTime, cacheManager, worldState) {
  const templates = POLITICS_DATA.campaign_events || {};

  for (const officeId in _elections) {
    const election = _elections[officeId];

    // Campaign rally
    if (Math.random() < POL.CAMPAIGN_EVENT_CHANCE) {
      const candidate = election.candidates[Math.floor(Math.random() * election.candidates.length)];
      const borough = _randomBorough();
      const rallyTemplates = templates.rallies || [];
      if (rallyTemplates.length > 0) {
        const template = rallyTemplates[Math.floor(Math.random() * rallyTemplates.length)];
        const headline = template
          .replace('{candidate}', candidate.name)
          .replace('{borough}', _formatBorough(borough))
          .replace('{location}', _formatBorough(borough));
        _addPoliticalNews(headline);
        election.events.push({ type: 'rally', tick: tickCount, text: headline });
        _emitPoliticsEvent('politics:rally', { candidate: candidate.name, borough, headline });

        // Rally boosts charisma slightly
        candidate.charisma = Math.min(100, candidate.charisma + 2);
      }
    }

    // Scandal
    if (Math.random() < POL.SCANDAL_CHANCE) {
      const candidate = election.candidates[Math.floor(Math.random() * election.candidates.length)];
      const scandalTemplates = templates.scandals || [];
      if (scandalTemplates.length > 0) {
        const template = scandalTemplates[Math.floor(Math.random() * scandalTemplates.length)];
        const headline = template.replace('{candidate}', candidate.name);
        _addPoliticalNews(headline);
        election.events.push({ type: 'scandal', tick: tickCount, text: headline });
        _emitPoliticsEvent('politics:scandal', { candidate: candidate.name, headline });

        candidate.charisma = Math.max(5, candidate.charisma - 8);
      }
    }

    // Endorsement
    if (Math.random() < POL.ENDORSEMENT_CHANCE) {
      const candidate = election.candidates[Math.floor(Math.random() * election.candidates.length)];
      const endorseTemplates = templates.endorsements || [];
      if (endorseTemplates.length > 0) {
        const template = endorseTemplates[Math.floor(Math.random() * endorseTemplates.length)];
        const headline = template
          .replace('{candidate}', candidate.name)
          .replace('{office}', election.office.title)
          .replace('{endorser}', _randomEndorserName())
          .replace('{borough}', _formatBorough(_randomBorough()));
        _addPoliticalNews(headline);
        election.events.push({ type: 'endorsement', tick: tickCount, text: headline });

        candidate.charisma = Math.min(100, candidate.charisma + 4);
      }
    }
  }
}

function _runPrimary(tickCount, cacheManager) {
  _electionPhase = 'primary';

  for (const officeId in _elections) {
    const election = _elections[officeId];
    // In primary: thin the field if more than MAX candidates
    if (election.candidates.length > POL.MAX_CANDIDATES_PER_RACE) {
      election.candidates.sort((a, b) => b.charisma - a.charisma);
      const eliminated = election.candidates.splice(POL.MAX_CANDIDATES_PER_RACE);
      for (const elim of eliminated) {
        if (elim.agentId) {
          const agent = cacheManager.getAgent(elim.agentId);
          if (agent) agent.politicalOffice = null;
        }
      }
    }
    election.phase = 'primary_complete';
  }

  _addPoliticalNews('Primary elections narrow the field. General election approaches!');
  eventBus.emitNow('log:world', '[Politics] Primary elections complete. Candidates advance to general.');
}

function _runGeneralElection(tickCount, cacheManager, worldState) {
  _electionPhase = 'transition';

  const agentIds = cacheManager.getAllAgentIds();
  const results = {};

  for (const officeId in _elections) {
    const election = _elections[officeId];
    const candidates = election.candidates;

    // Reset vote counts
    for (const c of candidates) c.voteCount = 0;

    // Tally votes
    for (const id of agentIds) {
      const agent = cacheManager.getAgent(id);
      if (!agent || !agent.isAlive || agent.lifeStage === 'child') continue;
      if (agent.lifeStage === 'teen' && agent.age < 18) continue;

      // Borough scope filter
      if (election.office.scope !== 'citywide') {
        const agentBorough = _getBoroughFromLocation(agent.homeLocationId);
        if (agentBorough !== election.office.scope) continue;
      }

      // Turnout check
      const turnoutChance = POL.VOTER_TURNOUT_BASE + (agent.politicalEngagement || 0) * POL.VOTER_TURNOUT_ENGAGEMENT_SCALE;
      if (Math.random() > turnoutChance) continue;

      const chosenId = castVote(agent, candidates, election.office);
      const chosen = candidates.find(c => (c.agentId || c.name) === chosenId);
      if (chosen) {
        chosen.voteCount++;

        // Record in agent's voting history
        if (!agent.votingHistory) agent.votingHistory = [];
        agent.votingHistory.push({ tick: tickCount, office: officeId, votedFor: chosen.name });
        if (agent.votingHistory.length > 5) agent.votingHistory.shift();
      }
    }

    // Determine winner
    candidates.sort((a, b) => b.voteCount - a.voteCount);
    const winner = candidates[0];
    const totalVotes = candidates.reduce((sum, c) => sum + c.voteCount, 0);
    const margin = totalVotes > 0 ? Math.round((winner.voteCount / totalVotes) * 100) : 0;

    results[officeId] = { winner, candidates, totalVotes, margin };

    // Generate result headline
    const newsTemplates = POLITICS_DATA.political_news?.results || [];
    if (newsTemplates.length > 0) {
      const template = newsTemplates[Math.floor(Math.random() * newsTemplates.length)];
      const loser = candidates.length > 1 ? candidates[1] : { name: 'the opposition' };
      const headline = template
        .replace('{winner}', winner.name)
        .replace('{office}', election.office.title)
        .replace('{margin}', margin > 60 ? 'decisive' : margin > 52 ? 'narrow' : 'razor-thin')
        .replace('{loser}', loser.name);
      _addPoliticalNews(headline);
      eventBus.emitNow('log:world', `[Politics] ELECTION RESULT: ${headline}`);
    }

    _emitPoliticsEvent('politics:electionResult', {
      office: officeId,
      winner: winner.name,
      party: winner.party,
      margin,
      totalVotes,
    });
  }

  // Store results for inauguration
  _elections._results = results;
}

export function castVote(agent, candidates, office) {
  if (!agent.politicalOpinions || candidates.length === 0) {
    return candidates[0]?.agentId || candidates[0]?.name;
  }

  let bestScore = -Infinity;
  let bestId = null;

  for (const candidate of candidates) {
    let score = 0;

    // Issue alignment (dot product normalized)
    const issues = ['crime_policing', 'development', 'rent_housing', 'transit', 'quality_of_life'];
    let alignment = 0;
    for (const issue of issues) {
      const agentPos = agent.politicalOpinions[issue] || 0;
      const candPos = candidate.positions[issue] || 0;
      // Closer positions = higher score; max distance per issue is 200
      alignment += (200 - Math.abs(agentPos - candPos)) / 200;
    }
    score += (alignment / issues.length) * 100 * POL.ISSUE_ALIGNMENT_WEIGHT;

    // Party loyalty
    if (agent.politicalParty === candidate.party) {
      score += 30 * POL.PARTY_LOYALTY_WEIGHT;
    }

    // Charisma
    score += (candidate.charisma / 100) * 30 * POL.CHARISMA_WEIGHT;

    // Incumbency bonus
    if (candidate.isIncumbent) {
      score += POL.INCUMBENCY_BONUS;
    }

    // Relationship bonus if agent knows candidate
    if (candidate.agentId && agent.relationships?.[candidate.agentId]) {
      const rel = agent.relationships[candidate.agentId];
      score += Math.max(0, (rel.affinity || 0)) * 0.2;
    }

    // Random noise to prevent deterministic outcomes
    score += (Math.random() * 10) - 5;

    if (score > bestScore) {
      bestScore = score;
      bestId = candidate.agentId || candidate.name;
    }
  }

  return bestId;
}

function _inaugurate(tickCount, cacheManager) {
  const results = _elections._results || {};

  for (const officeId in results) {
    const { winner } = results[officeId];

    // Clear previous officeholder's agent reference
    const prev = _officeholders[officeId];
    if (prev?.agentId) {
      const prevAgent = cacheManager.getAgent(prev.agentId);
      if (prevAgent) prevAgent.politicalOffice = null;
    }

    // Install new officeholder
    _officeholders[officeId] = {
      name: winner.name,
      agentId: winner.agentId,
      party: winner.party,
      positions: { ...winner.positions },
      approval: 50 + POL.APPROVAL_BOOST_ON_WIN,
      termStart: tickCount,
    };

    // Update agent
    if (winner.agentId) {
      const agent = cacheManager.getAgent(winner.agentId);
      if (agent) {
        agent.politicalOffice = officeId;
      }
    }

    _emitPoliticsEvent('politics:inauguration', { office: officeId, name: winner.name, party: winner.party });
  }

  // Clear candidacy from all agents
  const agentIds = cacheManager.getAllAgentIds();
  for (const id of agentIds) {
    const agent = cacheManager.getAgent(id);
    if (agent && agent.politicalOffice?.startsWith('candidate_for_')) {
      agent.politicalOffice = null;
    }
  }

  _termStartTick = tickCount;
  _electionPhase = 'none';
  _elections = {};

  _addPoliticalNews('New officeholders inaugurated. A new term begins for city government.');
  eventBus.emitNow('log:world', '[Politics] Inauguration complete. New term begins.');
}

export function getPoliticalState() {
  const electionInfo = {};
  for (const officeId in _elections) {
    if (officeId === '_results') continue;
    const e = _elections[officeId];
    electionInfo[officeId] = {
      office: e.office?.title,
      candidates: e.candidates?.map(c => ({
        name: c.name,
        party: c.party,
        charisma: c.charisma,
        isIncumbent: c.isIncumbent,
        voteCount: c.voteCount,
      })),
      phase: e.phase,
      eventCount: e.events?.length || 0,
    };
  }

  return {
    officeholders: { ..._officeholders },
    electionPhase: _electionPhase,
    elections: electionInfo,
    news: [..._politicalNews].slice(-5),
    recentEvents: [..._recentEvents].slice(-3),
    termStartTick: _termStartTick,
    daysIntoTerm: Math.floor((_lastPoliticsCheckTick - _termStartTick) / TICKS_PER_DAY),
    termLength: POL.TERM_LENGTH_DAYS,
  };
}

export function assignPoliticsToNewAgent(agent) {
  if (agent.politicalParty) return;
  const profile = generatePoliticalProfile(agent);
  agent.politicalParty = profile.party;
  agent.politicalOpinions = profile.opinions;
  agent.politicalEngagement = profile.engagement;
}

export function driftOpinion(agent, issue, amount) {
  if (!agent.politicalOpinions) return;
  if (!(issue in agent.politicalOpinions)) return;
  agent.politicalOpinions[issue] = Math.max(-100, Math.min(100,
    agent.politicalOpinions[issue] + amount
  ));
}

// --- Helpers ---

function _addPoliticalNews(headline) {
  _politicalNews.push(headline);
  if (_politicalNews.length > 20) _politicalNews.shift();
}

function _emitPoliticsEvent(eventName, data) {
  _recentEvents.push({ event: eventName, ...data, timestamp: Date.now() });
  if (_recentEvents.length > 10) _recentEvents.shift();
  eventBus.emitNow(eventName, data);
}

function _getBoroughFromLocation(locationId) {
  if (!locationId || typeof locationId !== 'string') return 'manhattan';
  if (locationId.startsWith('manhattan')) return 'manhattan';
  if (locationId.startsWith('brooklyn')) return 'brooklyn';
  if (locationId.startsWith('queens')) return 'queens';
  if (locationId.startsWith('bronx')) return 'bronx';
  if (locationId.startsWith('staten_island')) return 'staten_island';
  return 'manhattan';
}

function _randomBorough() {
  const boroughs = ['manhattan', 'brooklyn', 'queens', 'bronx', 'staten_island'];
  return boroughs[Math.floor(Math.random() * boroughs.length)];
}

function _formatBorough(borough) {
  const map = {
    manhattan: 'Manhattan',
    brooklyn: 'Brooklyn',
    queens: 'Queens',
    bronx: 'The Bronx',
    staten_island: 'Staten Island',
  };
  return map[borough] || borough;
}

function _randomEndorserName() {
  const endorsers = [
    'City Council Speaker', 'Former Mayor Koch', 'Rev. Al Sharpton',
    'Local union boss', 'A prominent developer', 'The PBA president',
    'UFT president', 'A well-known activist', 'Former borough president',
    'A Harlem pastor', 'A Wall Street executive', 'Community leader',
  ];
  return endorsers[Math.floor(Math.random() * endorsers.length)];
}

function _generateCandidateName() {
  const firsts = ['Anthony', 'Michael', 'Christine', 'Fernando', 'Ruth', 'Peter', 'Angela', 'Mark', 'Lisa', 'David', 'Patricia', 'Robert'];
  const lasts = ['Vallone', 'Messinger', 'Fields', 'Hevesi', 'Green', 'Badillo', 'Carrion', 'Thompson', 'Liu', 'Quinn', 'Stringer', 'de Blasio'];
  return `${firsts[Math.floor(Math.random() * firsts.length)]} ${lasts[Math.floor(Math.random() * lasts.length)]}`;
}
