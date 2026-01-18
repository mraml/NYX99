import blessed from 'blessed';
import contrib from 'blessed-contrib';
import eventBus from '../engine/eventBus.js';
import worldGraph from '../data/worldGraph.js';
import { UI_RENDER_RATE_MS } from '../data/config.js';
import logger from '../logger.js';
import { dataLoader } from '../data/dataLoader.js'; 

class Dashboard {
  static SPARKLINE_WIDTH = 10;
  static MAX_RELATIONSHIPS_SHOWN = 4;
  static MAX_SKILLS_SHOWN = 3;
  static MAX_MEMORIES_SHOWN = 3;
  static COLORS = {
      GOOD: 'green-fg',
      WARN: 'yellow-fg',
      BAD: 'red-fg',
      INFO: 'cyan-fg',
      GREY: 'grey-fg',
      WHITE: 'white-fg',
      BUFF: 'cyan-fg',   
      DEBUFF: 'magenta-fg' 
  };

  constructor() {
    global.dashboard = this;
    this._errorCount = 0; 
    this._isLogging = false;

    // === Capture Console Output (Safe Mode) ===
    if (console.log._isDashboardHook) {
        console.log = console.log._original || console.log;
    }
    if (console.error._isDashboardHook) {
        console.error = console.error._original || console.error;
    }

    this.originalLog = console.log;
    this.originalError = console.error;

    const logWrapper = (...args) => {
        if (this._isLogging) return; 
        const msg = args.map(String).join(' ');
        try {
            this._isLogging = true;
            if (eventBus && eventBus.emitNow) eventBus.emitNow('log:system', msg);
        } catch (e) { } finally {
            this._isLogging = false;
        }
    };
    logWrapper._isDashboardHook = true;
    logWrapper._original = this.originalLog;
    console.log = logWrapper;

    const errorWrapper = (...args) => {
        if (this._isLogging) return; 
        const msg = args.map(String).join(' ');
        try {
            this._isLogging = true;
            if (eventBus && eventBus.emitNow) eventBus.emitNow('log:error', msg);
        } catch (e) { } finally {
            this._isLogging = false;
        }
    };
    errorWrapper._isDashboardHook = true;
    errorWrapper._original = this.originalError;
    console.error = errorWrapper;

    this.screen = blessed.screen({
      smartCSR: true,
      title: 'NYC 1999 - The Matrix',
      autoPadding: true,
      mouse: true,
      fullUnicode: true,
      terminal: 'xterm-256color' 
    });

    this.grid = new contrib.grid({
      rows: 12,
      cols: 12,
      screen: this.screen,
    });

    this.agentsInFocusCache = [];
    this.selectedAgentId = null;
    this.latestState = null;
    this.lastRenderedTick = -1; 
    this.renderInterval = null;
    this.dbService = null;
    this.cacheManager = null; 
    this.focusedAgentMemories = [];
    this.lastFocusedAgentId = null;
    
    this._nodeCache = new Map();
    this._agentNameMap = new Map();
    this._lastAgentCount = 0;

    // --- Layout ---
    this.headerBox = this.grid.set(0, 0, 2, 8, blessed.box, {
      label: '{bold}[ Architect\'s Console ]{/bold}',
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'cyan' } },
      content: 'Initializing...'
    });

    this.worldBox = this.grid.set(0, 8, 2, 4, blessed.box, {
      label: '{bold}[ World & Activity ]{/bold}',
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'yellow' } },
      content: 'Loading...',
    });

    this.locationBox = this.grid.set(2, 0, 10, 8, blessed.box, {
      label: '{bold}[ Simulant List (All) ]{/bold}',
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'cyan' } },
    });

    this.agentListHeader = blessed.box({
      parent: this.locationBox,
      top: 0, left: 1, right: 1, height: 1,
      tags: true,
      content: '{bold}NAME'.padEnd(24) + '   ' + 
               'CAREER'.padEnd(22) + '   ' + 
               'LOCATION'.padEnd(23) + '   ' + 
               'ACTIVITY'.padEnd(25) + '   ' + 
               'ACTION{/bold}',
      style: { fg: 'white' }
    });

    this.agentList = blessed.list({
      parent: this.locationBox,
      top: 1, left: 0, right: 0, bottom: 0,
      padding: { left: 1, right: 1 },
      keys: true,
      mouse: true,
      vi: true,
      tags: true,
      style: { selected: { bg: 'blue' } },
      items: ['(Loading simulants...)'],
    });

    this.agentDetailBox = this.grid.set(2, 8, 6, 4, blessed.box, {
      label: '{bold}[ Agent Details ]{/bold}',
      content: 'Use ↑/↓ to select an agent.',
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'white' } },
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      keys: true,
      vi: true,
    });

    this.logBox = this.grid.set(8, 8, 4, 4, contrib.log, {
      label: '{bold}[ System Log ]{/bold}',
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'red' } },
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      keys: true,
      vi: true,
    });

    this.setupDataListener();
    this.startRenderLoop();
    this.setupKeybindings();
    this.setupLogListener();
  }
  
  emergencyShutdown() {
    try {
      if (console.log._original) console.log = console.log._original;
      if (console.error._original) console.error = console.error._original;
      if (this.renderInterval) clearInterval(this.renderInterval);
      if (this.screen) this.screen.destroy();
      
      if (process.stdout.isTTY) {
        process.stdout.write('\x1b[?1000l'); 
        process.stdout.write('\x1bc');       
      }
    } catch (e) {
      if (process.stdout.isTTY) process.stdout.write('\x1bc');
    }
  }

  shutdown() {
    this.emergencyShutdown();
  }

  safeString(value, defaultValue = 'N/A') {
    if (value === null || value === undefined) return defaultValue;
    if (typeof value === 'object') return 'Object';
    return String(value);
  }
  safeNumber(value, defaultValue = 0) {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? defaultValue : parsed;
  }
  safeGet(obj, path, defaultValue = null) {
    try {
      return path.split('.').reduce((o, k) => (o || {})[k], obj) ?? defaultValue;
    } catch (e) { return defaultValue; }
  }
  
  getFormattedAction(agent) {
      try {
          if (!agent) return 'Unknown';
          
          // Case 1: Digital Interaction
          if (agent.socialState && agent.socialState.isDigital && (agent.state === 'fsm_socializing' || agent.state === 'fsm_idle')) {
              const partner = agent.socialState.partnerName || 'Friend';
              return `Texting ${partner}`;
          }

          // Case 2: Intent-Driven (The "Why")
          let raw = this.safeString(agent.currentActivity, '').trim();
          const activeIntention = agent.intentionStack && agent.intentionStack.length > 0 
              ? agent.intentionStack[agent.intentionStack.length - 1] 
              : null;

          // Priority 1: High-level State override (Sleeping/Eating/Working shouldn't show "Idling")
          if (agent.state === 'fsm_sleeping') return 'Sleeping';
          if (agent.state === 'fsm_eating') return 'Eating';
          if (agent.state.startsWith('fsm_working')) return 'Working';
          if (agent.state === 'fsm_commuting') return 'Commuting';
          if (agent.state === 'fsm_in_transit') {
              // Try to find what they are doing while moving
              const lower = raw.toLowerCase();
              if (!lower.includes('walk') && !lower.includes('subway') && !lower.includes('transit') && !lower.includes('travel')) {
                  return 'Traveling...';
              }
              return raw; // "Walking", "Taking Subway"
          }

          // Priority 2: Active Intention (e.g. "Seeking Food")
          if (activeIntention && activeIntention.goal) {
              const reason = activeIntention.reason ? ` (${activeIntention.reason})` : '';
              // Format: "Goal: Find Food (Hungry)"
              let prettyGoal = activeIntention.goal.replace('fsm_', '').replace(/_/g, ' ');
              return `Goal: ${prettyGoal}${reason}`;
          }

          // Priority 3: Fallback to formatted state name if activity is generic "Idling"
          if ((!raw || raw === 'Idling') && agent.state && agent.state !== 'fsm_idle') {
              return agent.state.replace('fsm_', '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          }

          // Priority 4: Raw string, or just "Idle"
          return raw || 'Idle';
      } catch (e) {
          return 'Processing...';
      }
  }

  getPersonalityTraits(agent) {
      const p = agent.persona || {};
      const traits = [];
      if (p.extroversion > 0.7) traits.push('Gregarious');
      else if (p.extroversion < 0.3) traits.push('Loner');
      if (p.stressProneness > 0.7) traits.push('Anxious');
      else if (p.stressProneness < 0.3) traits.push('Chill');
      if (p.conscientiousness > 0.7) traits.push('Diligent');
      else if (p.conscientiousness < 0.3) traits.push('Chaotic');
      return traits.length ? traits.join(', ') : 'Average';
  }

  getTopSkills(agent) {
      const skills = agent.skills || {};
      return Object.entries(skills)
          .sort(([,a], [,b]) => b - a)
          .slice(0, Dashboard.MAX_SKILLS_SHOWN)
          .map(([name, val]) => `${name.substring(0,10)}:${val.toFixed(0)}`)
          .join(' ');
  }

  getCivStats(agents) {
      let homelessCount = 0, unemployedCount = 0, sickCount = 0, totalWealth = 0;
      const jobCounts = {};
      agents.forEach(a => {
          if (a.state === 'fsm_homeless') homelessCount++;
          if (!a.job || !a.job.title || a.job.title === 'Unemployed') unemployedCount++;
          if (a.status_effects && a.status_effects.some(e => e.type === 'SICK')) sickCount++;
          totalWealth += (a.money || 0);
          if (a.job && a.job.title) jobCounts[a.job.title] = (jobCounts[a.job.title] || 0) + 1;
      });
      const topJob = Object.entries(jobCounts).sort(([,a], [,b]) => b - a)[0];
      return {
          homeless: homelessCount,
          unemployed: unemployedCount,
          sick: sickCount,
          totalWealth: totalWealth,
          topJob: topJob ? `${topJob[0]} (${topJob[1]})` : 'None'
      };
  }
  
  getJobColor(jobTitle) {
      const title = (jobTitle || '').toLowerCase();
      if (title === 'unemployed') return 'grey-fg';
      if (title.includes('manager') || title.includes('executive') || title.includes('director')) return 'magenta-fg'; 
      if (title.includes('engineer') || title.includes('developer') || title.includes('programmer')) return 'cyan-fg'; 
      if (title.includes('artist') || title.includes('musician') || title.includes('writer')) return 'yellow-fg'; 
      if (title.includes('nurse') || title.includes('doctor') || title.includes('teacher')) return 'green-fg'; 
      return 'white-fg';
  }

  getLocationColor(locationType) {
      const type = (locationType || '').toLowerCase();
      if (type === 'home') return 'blue-fg';
      if (type === 'office' || type === 'school') return 'white-fg';
      if (type === 'park') return 'green-fg';
      if (type === 'bar' || type === 'club' || type === 'restaurant') return 'magenta-fg';
      if (type === 'store' || type === 'market') return 'yellow-fg';
      return 'grey-fg';
  }

  getActivityColor(activityName) {
      const act = (activityName || '').toLowerCase();
      if (act.includes('sleep')) return 'blue-fg';
      if (act.includes('eat') || act.includes('drink')) return 'green-fg';
      if (act.includes('work')) return 'red-fg'; 
      if (act.includes('shop')) return 'yellow-fg';
      if (act.includes('social') || act.includes('chat') || act.includes('text')) return 'magenta-fg';
      return 'white-fg';
  }

  setDbService(dbService) { this.dbService = dbService; }
  setCacheManager(cacheManager) { this.cacheManager = cacheManager; }

  getObservedAgentId() { return this.selectedAgentId; }

  setupDataListener() {
    eventBus.on('matrix:tickComplete', (data) => { 
        this.latestState = data; 
        if (data.tick === 1) {
            try { this.render(data); } catch (e) { /* swallow */ }
        }
    });
  }

  startRenderLoop() {
    this.renderInterval = setInterval(() => {
      if (this.latestState) {
        try {
          this.updateFocusedAgentMemories();
          this.render(this.latestState);
        } catch (err) {
           this._errorCount++;
           if (this._errorCount > 100) { 
             this.emergencyShutdown();
             if (this.originalError) this.originalError('CRITICAL UI FAILURE: Stopping render loop.');
             clearInterval(this.renderInterval);
           }
        }
      }
    }, UI_RENDER_RATE_MS);
  }

  makeSparkline(data, width = Dashboard.SPARKLINE_WIDTH, color = 'white') {
      if (!data || data.length === 0) return ' '.repeat(width + 2);
      
      const subset = data.slice(-width); 
      const min = Math.min(...subset);
      const max = Math.max(...subset);
      const range = max - min || 1;
      const bars = [' ', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
      
      let line = '';
      for (const val of subset) {
          const normalized = (val - min) / range;
          const index = Math.floor(normalized * (bars.length - 1));
          line += bars[index];
      }

      const isRising = subset.length > 2 && subset[subset.length - 1] > subset[0];
      const isFalling = subset.length > 2 && subset[subset.length - 1] < subset[0];
      const trend = isRising ? '{green-fg}↑{/green-fg}' : isFalling ? '{red-fg}↓{/red-fg}' : '{grey-fg}-{/grey-fg}';
      
      return `{${color}-fg}${line.padStart(width, ' ')}{/${color}-fg} ${trend}`;
  }

  formatNeed(label, value, max = 100, isInverted = false) {
    const safeValue = this.safeNumber(value, 0);
    const safeMax = this.safeNumber(max, 100);
    const percentGood = isInverted 
        ? Math.max(0, 100 - (safeValue / safeMax) * 100)
        : Math.min(100, (safeValue / safeMax) * 100);

    const barLength = 10;
    const filled = Math.round((percentGood / 100) * barLength);
    const empty = barLength - filled;
    let color = Dashboard.COLORS.GOOD;
    if (percentGood < 60) color = Dashboard.COLORS.WARN;
    if (percentGood < 30) color = Dashboard.COLORS.BAD;
    
    return `${label.padEnd(7)}: {${color}}[${'|'.repeat(filled)}${'.'.repeat(empty)}]{/${color}} ${percentGood.toFixed(0).padStart(3)}%`;
  }

  formatEmotion(label, value) {
    const safeValue = this.safeNumber(value, 0); 
    const normalized = ((safeValue + 100) / 200) * 100; 
    let color = Dashboard.COLORS.WHITE;
    if (label === 'Stress' || label === 'Burnout') {
        if (normalized > 70) color = Dashboard.COLORS.BAD;
        else if (normalized > 40) color = Dashboard.COLORS.WARN;
    } else { 
        if (normalized < 30) color = Dashboard.COLORS.BAD;
        else if (normalized < 60) color = Dashboard.COLORS.WARN;
    }
    return `${label.padEnd(7)}: {${color}}${normalized.toFixed(0).padStart(3)}%{/${color}}`;
  }

  makeBar(value, max) {
      const pct = Math.min(100, Math.max(0, (value / max) * 100));
      const filled = Math.floor(pct / 10);
      return `[${'|'.repeat(filled)}${' '.repeat(10 - filled)}]`;
  }

  getCityEconomyStats() {
      let totalTreasury = 0, totalCondition = 0, businessCount = 0, nodeCount = 0;
      for (const id in worldGraph.nodes) {
          const node = worldGraph.nodes[id];
          if (node.is_business) { totalTreasury += (node.treasury || 0); businessCount++; }
          if (node.condition !== undefined) { totalCondition += node.condition; nodeCount++; }
      }
      return {
          avgTreasury: businessCount ? (totalTreasury / businessCount).toFixed(0) : 0,
          avgCondition: nodeCount ? (totalCondition / nodeCount).toFixed(1) : 0
      };
  }

  formatAgentDetails(agent) {
      const safeId = (typeof agent.id === 'string') ? agent.id : JSON.stringify(agent.id).replace(/"/g, '');
      
      let content = `{bold}${agent.name}{/bold} (ID: ${safeId.substring(0, 4)})\n`;
      content += `{blue-fg}${agent.job?.title || 'Unemployed'}{/blue-fg} @ ${agent.workLocationId || 'N/A'}\n`;
      content += `Loc: ${agent.locationId || 'Unknown'}\n`;
      content += `State: {yellow-fg}${agent.state}{/yellow-fg}\n`;
      content += `Action: ${this.getFormattedAction(agent)}\n`; 
      
      // NEW: Show Intention
      const intention = agent.intentionStack && agent.intentionStack.length > 0 
          ? agent.intentionStack[agent.intentionStack.length - 1] 
          : null;
      if (intention) {
          content += `Intent: {cyan-fg}${intention.goal || 'None'}{/cyan-fg} (${intention.reason || ''})\n`;
      }
      content += '\n';

      content += `{bold}Stats:{/bold}\n`;
      content += `  Money: $${Math.round(agent.money || 0)}\n`;
      content += `  Energy: ${this.progressBar(agent.energy)}\n`;
      content += `  Hunger: ${this.progressBar(agent.hunger)}\n`;
      content += `  Social: ${this.progressBar(agent.social)}\n\n`;
      
      content += `{bold}Status:{/bold}\n`;
      const effects = agent.status_effects ?? [];
      let statusStr = '{green-fg}Normal{/green-fg}';
      if (effects.length > 0) {
          statusStr = effects.map(e => {
              const dur = e.duration ? `(${e.duration}t)` : '';
              let color = Dashboard.COLORS.WHITE;
              
              if (['SICK', 'GROGGY', 'LETHARGIC', 'EXHAUSTED'].includes(e.type)) color = Dashboard.COLORS.BAD;
              else if (['WELL_FED', 'WELL_RESTED', 'CONNECTED', 'FLOWING'].includes(e.type)) color = Dashboard.COLORS.BUFF;
              else if (['STRESSED', 'INSOMNIA', 'BURNOUT'].includes(e.type)) color = Dashboard.COLORS.WARN;
              
              return `{${color}}${e.type}{/${color}}${dur}`;
          }).join(', ');
      }
      content += `  ${statusStr}\n\n`;

      // NEW: Skills
      const skillsStr = this.getTopSkills(agent);
      if (skillsStr) {
          content += `{bold}Skills:{/bold} ${skillsStr}\n`;
      }

      // NEW: Inventory
      const inventory = agent.inventory || [];
      if (inventory.length > 0) {
          content += `{bold}Inventory:{/bold} ${inventory.map(i => i.itemId || i.type).join(', ').substring(0, 50)}\n`;
      }

      const habits = agent.habits || {};
      const sortedHabits = Object.entries(habits)
          .map(([act, locs]) => {
              const locsObj = (locs && typeof locs === 'object') ? locs : {};
              const total = Object.values(locsObj).reduce((a,b) => (Number(a)||0) + (Number(b)||0), 0);
              return { act, total };
          })
          .sort((a,b) => b.total - a.total);
      
      if (sortedHabits.length > 0) {
          content += `Top Habit: ${sortedHabits[0].act} (x${sortedHabits[0].total})\n`;
      }

      return content;
  }

  progressBar(value) {
      const val = Math.max(0, Math.min(100, value || 0));
      const bars = Math.floor(val / 10);
      const color = val > 70 ? '{green-fg}' : val > 30 ? '{yellow-fg}' : '{red-fg}';
      return `${color}${'|'.repeat(bars)}${' '.repeat(10-bars)}{/}`;
  }

  render(data) {
    try {
      if (!data) return;
      
      const agents = Array.isArray(data.agents) ? data.agents.filter(a => a) : [];
      const worldState = data.worldState || {};
      const tick = this.safeNumber(data.tick, 0);
      
      const getNode = (id) => {
          if (!id) return null;
          if (!this._nodeCache.has(id)) this._nodeCache.set(id, worldGraph.nodes[id]);
          return this._nodeCache.get(id);
      };

      this.agentsInFocusCache = agents.sort((a, b) => {
          const nameA = (a?.name || '').toLowerCase();
          const nameB = (b?.name || '').toLowerCase();
          if (nameA < nameB) return -1;
          if (nameA > nameB) return 1;
          return 0;
      });

      if (agents.length !== this._lastAgentCount) {
          this._agentNameMap.clear();
          agents.forEach(a => this._agentNameMap.set(a.id, a.name));
          this._lastAgentCount = agents.length;
      }
      const agentNameMap = this._agentNameMap;

      // Header
      try {
        const worldDate = new Date(this.safeString(data.time));
        const timeString = worldDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const lightLevel = this.safeNumber(worldState.environment?.globalLight, 0.5);
        const dayNightIcon = lightLevel > 0.4 ? '{yellow-fg}(D){/yellow-fg}' : '{grey-fg}(N){/grey-fg}';
        let totHunger = 0, totEnergy = 0, totSocial = 0;
        agents.forEach(a => {
            totHunger += (100 - this.safeNumber(a.hunger, 0)); 
            totEnergy += this.safeNumber(a.energy, 0);         
            totSocial += (100 - this.safeNumber(a.social, 0)); 
        });
        const avgHunger = agents.length ? Math.round(totHunger / agents.length) : 0;
        const avgEnergy = agents.length ? Math.round(totEnergy / agents.length) : 0;
        const avgSocial = agents.length ? Math.round(totSocial / agents.length) : 0;
        const avgNeeds = `H:${this.makeBar(avgHunger, 100)} E:${this.makeBar(avgEnergy, 100)} S:${this.makeBar(avgSocial, 100)}`;
        this.headerBox.setContent(
          ` {cyan-fg}{bold}TIME:{/bold}{/cyan-fg} ${timeString} ${dayNightIcon} | ${worldDate.toDateString()}\n` +
          ` {cyan-fg}{bold}STATUS:{/bold}{/cyan-fg} Uptime: ${tick}t | Agents: ${agents.length}\n` +
          ` {cyan-fg}{bold}NEEDS:{/bold}{/cyan-fg}  ${avgNeeds}`
        );
      } catch (err) {
        this.headerBox.setContent(`{red-fg}Header Error{/red-fg}`);
      }

      // World Box
      try {
          const weather = worldState.weather || {};
          const weatherDesc = weather.weather ? `${weather.weather}` : 'Clear';
          const temp = weather.temp ? `${(18 + weather.temp).toFixed(0)}°C` : '18°C';
          const news = worldState.news ? worldState.news.substring(0, 60) + (worldState.news.length > 60 ? '...' : '') : 'No major headlines.';
          const events = (worldState.activeEvents || []).map(e => e.name).join(', ') || 'None';
          const atmosphere = worldState.sensoryEvent ? `{cyan-fg}${worldState.sensoryEvent.text}{/cyan-fg}` : (worldState.timeOfDayDesc || 'The city is quiet.');
          const cityStats = this.getCityEconomyStats();
          const civStats = this.getCivStats(agents);
          this.worldBox.setContent(
              `{bold}Weather:{/bold} ${weatherDesc}, ${temp}\n` +
              `{bold}Economy:{/bold} Avg Cash: $${cityStats.avgTreasury} | Infra: ${cityStats.avgCondition}%\n` +
              `{bold}Civ:{/bold}     Homeless: ${civStats.homeless} | Unemployed: ${civStats.unemployed} | Sick: ${civStats.sick} | Top Job: ${civStats.topJob}\n` +
              `{bold}News:{/bold}    ${news}\n` +
              `{bold}Events:{/bold}  ${events}\n` +
              `{bold}Vibe:{/bold}    ${atmosphere}`
          );
      } catch (err) {
          this.worldBox.setContent(`{red-fg}World Data Error{/red-fg}`);
      }

      // Agent List
      try {
        const listItems = this.agentsInFocusCache.map(agent => {
          try {
            const safeId = agent.id && typeof agent.id === 'string' ? agent.id : '???';
            const lodMarker = agent.lod === 1 ? '{green-fg}█{/green-fg} ' : '  '; 
            const hungerBad = this.safeNumber(agent.hunger, 0) > 60; 
            const energyBad = this.safeNumber(agent.energy, 100) < 40; 
            const socialBad = this.safeNumber(agent.social, 0) > 60; 
            let indicator = '  ';
            if (hungerBad || energyBad || socialBad) indicator = '{red-fg}‼ {/red-fg}';
            else if (this.safeNumber(agent.stress, 0) > 60) indicator = '{yellow-fg}! {/yellow-fg}';
            const rawName = this.safeString(agent.name, 'UNKNOWN').padEnd(20).substring(0, 20);
            const nameStr = lodMarker + indicator + rawName;
            const rawJob = this.safeString(this.safeGet(agent, 'job.title'), 'None').padEnd(22).substring(0, 22);
            const jobColor = this.getJobColor(rawJob);
            const jobStr = `{${jobColor}}${rawJob}{/${jobColor}}`; 
            const node = getNode(agent.locationId);
            let locName = 'Unknown', locType = 'unknown';
            if (node) { locName = node.name || 'Loc'; locType = node.type || 'unknown'; } 
            else if (agent.state === 'fsm_in_transit') { locName = 'Traveling...'; locType = 'transit'; }
            const rawLoc = locName.padEnd(23).substring(0, 23);
            const locColor = this.getLocationColor(locType);
            const locStr = `{${locColor}}${rawLoc}{/${locColor}}`;
            let activityRaw = this.safeString(agent.currentActivityName || agent.state, 'idle').replace('fsm_', '');
            const actStr = activityRaw.padEnd(25).substring(0, 25);
            let actionText = this.getFormattedAction(agent);
            const actionDetail = actionText.padEnd(70).substring(0, 70);
            const actColor = this.getActivityColor(activityRaw);
            const actionStr = `{${actColor}}${actionDetail}{/${actColor}}`;
            return `${nameStr}   ${jobStr}   ${locStr}   ${actStr}   ${actionStr}`;
          } catch (e) { return `ERR: ${agent?.id ? String(agent.id) : 'bad_id'}`; }
        });
        this.agentList.setItems(listItems);
      } catch (err) {
      }
      this.lastRenderedTick = tick;

      // Agent Details
      try {
        const agent = this.selectedAgentId ? agents.find(a => a.id === this.selectedAgentId) : null;
        if (agent) {
          this.agentDetailBox.setLabel(`{bold}[ ${agent.name} ]{/bold}`);
          const formattedDetails = this.formatAgentDetails(agent);
          
          const rels = agent.relationships ?? {};
          const relList = Object.entries(rels)
              .filter(([id, r]) => r && id)
              .sort(([, a], [, b]) => (b.affinity ?? 0) - (a.affinity ?? 0))
              .slice(0, Dashboard.MAX_RELATIONSHIPS_SHOWN)
              .map(([id, r]) => {
                   const aff = this.safeNumber(r.affinity, 0);
                   const bar = this.makeBar(aff + 100, 200); 
                   const color = aff > 50 ? 'green-fg' : aff < -20 ? 'red-fg' : 'white-fg';
                   let pName = agentNameMap.get(id);
                   if (!pName) pName = `ID:${String(id).substring(0,4)}`;
                   let sharedStr = '';
                   const partner = agents.find(a => a.id === id);
                   if (partner && agent.interests && partner.interests) {
                       const shared = agent.interests.filter(i => partner.interests.includes(i));
                       if (shared.length > 0) sharedStr = ` {grey-fg}[${shared.slice(0,2).join(',')}] {/grey-fg}`;
                   }
                   const pNameStr = pName.substring(0, 18).padEnd(18);
                   return ` - ${pNameStr} {${color}}${r.type}{/${color}}${sharedStr} ${bar}`;
              }).join('\n');
          
          this.agentDetailBox.setContent(
              formattedDetails + 
              `{bold}Needs & Emotions{/bold}
Mood:   ${this.formatEmotion('Mood', agent.mood)} ${this.makeSparkline(agent.history?.mood, 10, 'cyan')}
Stress: ${this.formatEmotion('Stress', agent.stress)} ${this.makeSparkline(agent.history?.stress, 10, 'red')}
Burnout:${this.formatEmotion('Burnout', agent.burnout)}

${this.formatNeed('Energy', agent.energy, 100, false)} ${this.makeSparkline(agent.history?.energy, 8, 'yellow')}
${this.formatNeed('Hunger', agent.hunger, 100, true)}
${this.formatNeed('Social', agent.social, 100, true)}
${this.formatNeed('Boredom', agent.boredom, 100, true)}

{bold}Relationships{/bold}
${relList || 'None'}

{bold}Memories{/bold}
${(this.focusedAgentMemories || []).slice(0, 3).map(m => {
    const desc = m?.description || 'No description';
    return `- ${desc.substring(0, 40)}`;
}).join('\n') || 'None'}`
          );
        } else {
          this.agentDetailBox.setContent(
              `\n{center}{bold}No Agent Selected{/bold}{/center}\n\n` +
              `{center}Active Agents: ${agents.filter(a=>a.lod===1).length} | Background: ${agents.filter(a=>a.lod===2).length}{/center}`
          );
        }
      } catch (err) {
          this.agentDetailBox.setContent(`Render Error: ${err.message}`);
      }
      this.screen.render();
    } catch (err) {
        // Fatal Render Error catch
    }
  }
  
  updateFocusedAgentMemories() {
      if (!this.dbService || !this.selectedAgentId) return;
      try {
          if (this.selectedAgentId !== this.lastFocusedAgentId) {
              const memories = this.dbService.getAgentMemories(this.selectedAgentId, 10);
              this.focusedAgentMemories = Array.isArray(memories) ? memories : [];
              this.lastFocusedAgentId = this.selectedAgentId;
          }
      } catch(e) {
          this.focusedAgentMemories = [];
      }
  }

  setupKeybindings() {
      this.screen.key(['C-q', 'S-q', 'C-c'], () => {
        this.emergencyShutdown();
        eventBus.emitNow('system:shutdown');
        // Do NOT call process.exit(0) immediately. Let index.js handle the graceful shutdown sequence.
      });
      this.agentList.on('select item', (item, idx) => {
          try {
            this.selectedAgentId = this.agentsInFocusCache[idx]?.id || null;
          } catch (e) {
            logger.error(`Selection error: ${e.message}`);
          }
      });
      this.agentList.focus();
  }

  setupLogListener() {
      const safeLog = (msg, color) => {
        try {
          const cleaned = String(msg)
            .replace(/[\x00-\x1F\x7F-\x9F]/g, '') 
            .substring(0, 500); 
          this.logBox.log(`{${color}}${cleaned}{/${color}}`);
        } catch (e) {
          // Swallow
        }
      };
      eventBus.on('log:agent', msg => safeLog(msg, 'white-fg'));
      eventBus.on('log:error', msg => safeLog(msg, 'red-fg'));
      eventBus.on('log:world', msg => safeLog(msg, 'bold}{magenta-fg'));
      eventBus.on('log:info', msg => safeLog(msg, 'green-fg'));
      eventBus.on('log:system', msg => safeLog(msg, 'yellow-fg'));
  }
}

export default Dashboard;