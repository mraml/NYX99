import blessed from 'blessed';
import contrib from 'blessed-contrib';
import eventBus from '../engine/eventBus.js';
import worldGraph from '../data/worldGraph.js';
import { UI_RENDER_RATE_MS, TICK_RATE_MS } from '../data/config.js';

/** Sim ticks between observer advances (~5 real minutes at current TICK_RATE_MS). */
const AUTO_CYCLE_INTERVAL_TICKS = Math.max(1, Math.round((5 * 60 * 1000) / TICK_RATE_MS));
import logger from '../logger.js';
// [Refined] Import the Maps to correlate data
import { dataLoader, ACTIVITIES_MAP, ACTIVITY_COSTS, POLITICS_DATA, CALENDAR_EVENTS, AMBIENT_CITY_STATUS } from '../data/dataLoader.js';

const WORLD_EVENT_TYPE_LABELS = {
  SUBWAY_DELAY: 'Subway delays',
  HEAT_WAVE: 'Heat wave',
  CAMPAIGN_RALLY: 'Campaign rally',
  CITY_FLAVOR: 'City scene',
};

function formatWorldEventLine(e) {
  if (e.description && String(e.description).trim()) {
    const s = String(e.description).trim();
    return s.length > 48 ? `${s.slice(0, 45)}...` : s;
  }
  const t = e.type;
  if (WORLD_EVENT_TYPE_LABELS[t]) return WORLD_EVENT_TYPE_LABELS[t];
  return t ? t.replace(/_/g, ' ').toLowerCase() : '';
}

/** Deterministic weighted pick so the Events line does not flicker between renders. */
function pickWeightedAmbient(tick) {
  const list = AMBIENT_CITY_STATUS;
  if (!list?.length) return 'The city hums along.';
  const expanded = [];
  for (const item of list) {
    const text = typeof item === 'string' ? item : item?.text;
    const w = typeof item === 'object' && item != null && typeof item.weight === 'number' ? item.weight : 5;
    if (text) expanded.push({ text, weight: w });
  }
  if (!expanded.length) return 'The city hums along.';
  const total = expanded.reduce((s, x) => s + x.weight, 0);
  let pick = total > 0 ? ((tick * 7919 + 31) >>> 0) % total : 0;
  for (const x of expanded) {
    pick -= x.weight;
    if (pick < 0) return x.text;
  }
  return expanded[expanded.length - 1].text;
}

function formatCalendarLine(displayDate) {
  if (!CALENDAR_EVENTS.length) return '';
  const m = displayDate.getMonth() + 1;
  const d = displayDate.getDate();
  const todayNames = CALENDAR_EVENTS.filter((e) => e.month === m && e.day === d).map((e) => e.name);
  const todayStr = todayNames.length ? todayNames.join(', ') : '—';
  let nextStr = '—';
  for (let i = 1; i <= 14; i++) {
    const nd = new Date(displayDate.getTime());
    nd.setDate(nd.getDate() + i);
    const nm = nd.getMonth() + 1;
    const ndd = nd.getDate();
    const hit = CALENDAR_EVENTS.find((e) => e.month === nm && e.day === ndd);
    if (hit) {
      nextStr = `${hit.name} (${i}d)`;
      break;
    }
  }
  return `{bold}Calendar:{/bold} Today: ${todayStr} | Next: ${nextStr}`;
}

class Dashboard {
  static SPARKLINE_WIDTH = 10;
  static MAX_RELATIONSHIPS_SHOWN = 4;
  static MAX_SKILLS_SHOWN = 3;
  static MAX_MEMORIES_SHOWN = 3;
  static MAX_NEARBY_SHOWN = 5;
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
    
    // [FIX 6] Console Hook Reentrancy Guard (Queue System)
    this._logQueue = [];
    
    // [FIX 11] List Update Optimization Signature
    this._lastListSignature = '';

    // === Capture Console Output (Safe Mode) ===
    // We hook mostly to capture main thread logs. 
    // Worker logs piped to stdout will still corrupt unless the parent process (index.js) pipes them.
    if (console.log._isDashboardHook) {
        console.log = console.log._original || console.log;
    }
    if (console.error._isDashboardHook) {
        console.error = console.error._original || console.error;
    }

    this.originalLog = console.log;
    this.originalError = console.error;

    const logWrapper = (...args) => {
        const msg = args.map(String).join(' ');
        this._logQueue.push({ type: 'log:system', msg });
    };
    logWrapper._isDashboardHook = true;
    logWrapper._original = this.originalLog;
    console.log = logWrapper;

    const errorWrapper = (...args) => {
        const msg = args.map(String).join(' ');
        this._logQueue.push({ type: 'log:error', msg });
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
      terminal: 'xterm-256color',
      // [FIX] Ensure dock/resize events don't break layout
      dockBorders: true
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

    // Observer / auto-cycle state
    this.autoCycleMode = false;
    this.autoCycleSpeed = AUTO_CYCLE_INTERVAL_TICKS; // ticks between agent advances
    this.autoCycleAgentIdx = 0;
    this.autoCycleLastAgentTick = 0;
    this._suppressSelectEvent = false; // prevents programmatic select from cancelling cycle mode

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
      content: '{bold}' + ' '.repeat(4) + 'NAME/AGE'.padEnd(24) + '   ' + 
               'CAREER'.padEnd(20) + '   ' + 
               'LOCATION'.padEnd(20) + '   ' + 
               'ACTIVITY'.padEnd(20) + '   ' + 
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

    this.agentDetailBox = this.grid.set(2, 8, 4, 4, blessed.box, {
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

    this.politicsBox = this.grid.set(6, 8, 2, 4, blessed.box, {
      label: '{bold}[ City Politics ]{/bold}',
      content: 'Loading political data...',
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'magenta' } },
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
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

    this.profilerBox = this.grid.set(8, 8, 4, 4, blessed.box, {
      label: '{bold}[ Event Profiler (Press V to toggle) ]{/bold}',
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'yellow' } },
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      keys: true,
      vi: true,
      hidden: true
    });

    this.viewMode = 'logs';

    this.setupDataListener();
    this.startRenderLoop();
    this.setupKeybindings();
    this.setupLogListener();
    
    // Process logs periodically
    setInterval(() => this._flushLogs(), 100);
    
    // [FIX] Initial Screen Clear to wipe any pre-launch logs
    this.screen.render();
  }
  
  _flushLogs() {
     if (this._logQueue.length === 0) return;
     // Process max 50 logs per tick to prevent starvation
     const batch = this._logQueue.splice(0, 50);
     batch.forEach(item => {
        try {
            // [FIX] Check for "Worker" logs and route them to log box instead of stdout
            if (eventBus && eventBus.emitNow) eventBus.emitNow(item.type, item.msg);
        } catch(e) {}
     });
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
  
  /**
   * RESOLVE RICH NAME
   * Forces the UI to lookup the "Flavor Name" from locations.yaml if the node
   * name is missing or generic.
   */
  getRichLocationName(node) {
      if (!node) return 'Unknown';
      
      // 1. Try to fetch from locations.yaml via dataLoader if available
      try {
          const locationsData = dataLoader.locations || {};
          // Check if consistent_locations exists for this type
          const namesList = locationsData.consistent_locations?.[node.type];
          
          if (namesList && namesList.length > 0) {
              // Re-calculate hash to match worldGraph's logic (Deterministic)
              // This ensures UI shows "Rudy's Bar" even if worldGraph didn't save it to the node object yet
              const hash = node.key.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
              return namesList[hash % namesList.length];
          }
      } catch (e) {
          // Fail silently to node.name
      }
      
      return node.name || node.key;
  }

  normalizeActivityDisplay(agent, activityRaw) {
      let display = this.safeString(activityRaw, 'idle').replace('fsm_', '').replace(/_/g, ' ').trim();
      const lower = display.toLowerCase();

      // Keep category signal but remove noisy job qualifiers.
      if (lower.startsWith('working') && /\([^)]*\)\s*$/.test(display)) {
          display = 'working';
      }

      // Retired activity should show what they're actually doing.
      if (lower.startsWith('senior leisure')) {
          const actionText = this.safeString(agent?.currentActivity, '').trim();
          const hasPlaceholder = /^\[[^\]]+\]$/.test(actionText) || actionText.includes('fsm_');
          display = (actionText && !hasPlaceholder) ? actionText : 'leisure';
      }

      return display.replace(/\b\w/g, c => c.toUpperCase());
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
          const activeIntention = agent.intentionStack && agent.intentionStack.length > 0 
              ? agent.intentionStack[agent.intentionStack.length - 1] 
              : null;

          // Priority 1: High-level State override
          if (agent.state === 'fsm_sleeping') return 'Sleeping';
          if (agent.state === 'fsm_commuting') return 'Commuting';
          
          if (agent.state === 'fsm_in_transit') {
              let raw = this.safeString(agent.currentActivity, '').trim();
              const lower = raw.toLowerCase();
              if (!lower.includes('walk') && !lower.includes('subway')) {
                  return 'Traveling...';
              }
              return raw; 
          }
          
          // Priority 2: Use specific currentActivity from YAML (never show [state] placeholders)
          let actionText = this.safeString(agent.currentActivity, '');
          const isBracketPlaceholder = /^\[[^\]]+\]$/.test(actionText.trim());

          if (actionText && actionText !== 'idle' && !actionText.includes('fsm_') && !isBracketPlaceholder) {
              return actionText;
          }

          // Priority 3: Active Intention (e.g. "Seeking Food")
          if (activeIntention && activeIntention.goal) {
              const reason = activeIntention.reason ? ` (${activeIntention.reason})` : '';
              let prettyGoal = activeIntention.goal.replace('fsm_', '').replace(/_/g, ' ');
              // Format appropriately if it's an action vs a category
              return prettyGoal + reason;
          }

          // Priority 4: Fallback to formatted state name if no specific action
          // This ensures that "Working" doesn't become "Playing Goldeneye" unless explicitly set
          // But if the action text WAS "Playing Goldeneye", Priority 2 would have caught it.
          // This block catches the case where currentActivity is empty or generic.
          if (agent.state && agent.state !== 'fsm_idle') {
              return agent.state.replace('fsm_', '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          }

          return 'Idle';
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

  _getOfficeTitle(officeId) {
      const offices = POLITICS_DATA?.offices || [];
      const match = offices.find(o => o.id === officeId);
      return match ? match.title : officeId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
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
      // [FIX 4] Stats Calculation Division by Zero Risk
      if (!agents || agents.length === 0) {
          return { homeless: 0, unemployed: 0, sick: 0, totalWealth: 0, topJob: 'None' };
      }

      let homelessCount = 0, unemployedCount = 0, sickCount = 0, totalWealth = 0;
      const jobCounts = {};
      agents.forEach(a => {
          if (a.state === 'fsm_homeless') homelessCount++;
          if (a.lifeStage !== 'child' && (!a.job || !a.job.title || a.job.title === 'Unemployed')) unemployedCount++;
          if (a.status_effects && a.status_effects.some(e => e.type === 'SICK')) sickCount++;
          totalWealth += (a.money || 0);
          if (a.lifeStage !== 'child' && a.job && a.job.title) jobCounts[a.job.title] = (jobCounts[a.job.title] || 0) + 1;
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
      if (title === 'student') return 'cyan-fg';
      if (title.includes('manager') || title.includes('executive') || title.includes('director')) return 'magenta-fg'; 
      if (title.includes('engineer') || title.includes('developer') || title.includes('programmer')) return 'cyan-fg'; 
      if (title.includes('artist') || title.includes('musician') || title.includes('writer')) return 'yellow-fg'; 
      if (title.includes('nurse') || title.includes('doctor') || title.includes('teacher')) return 'green-fg'; 
      return 'white-fg';
  }

  getLocationColor(locationType) {
      const type = (locationType || '').toLowerCase();
      if (type === 'transit') return 'cyan-fg';
      if (type === 'home') return 'blue-fg';
      if (type === 'office' || type === 'school') return 'white-fg';
      if (type === 'park') return 'green-fg';
      if (type === 'bar' || type === 'club' || type === 'restaurant') return 'magenta-fg';
      if (type === 'store' || type === 'market') return 'yellow-fg';
      return 'grey-fg';
  }

  resolveAgentLocationDisplay(agent, getNode) {
      const safeGetNode = typeof getNode === 'function'
          ? getNode
          : (id) => worldGraph.nodes?.[id];
      const currentNode = safeGetNode(agent?.locationId);
      if (currentNode) {
          return {
              name: this.getRichLocationName(currentNode),
              type: currentNode.type || 'unknown'
          };
      }

      const isTraveling = agent?.state === 'fsm_in_transit' ||
          agent?.state === 'fsm_commuting' ||
          !!agent?.stateContext?.isTraveling ||
          (this.safeNumber(agent?.travelTimer, 0) > 0) ||
          !!agent?.transitTo;

      if (isTraveling) {
          const fromId = agent?.transitFrom || agent?.locationId;
          const toId = agent?.transitTo || agent?.targetLocationId;
          const fromNode = safeGetNode(fromId);
          const toNode = safeGetNode(toId);
          const fromLabel = fromNode ? this.getRichLocationName(fromNode) : this.safeString(fromId, '?');
          const toLabel = toNode ? this.getRichLocationName(toNode) : this.safeString(toId, '?');
          return {
              name: `${fromLabel} -> ${toLabel}`,
              type: 'transit'
          };
      }

      const fallbackId = this.safeString(agent?.locationId || agent?.targetLocationId, 'Unknown');
      return { name: fallbackId, type: 'unknown' };
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
      // [FIX 8] Error Counter Decay
      if (this._errorCount > 0) {
          this._errorCount--;
      }

      if (this.latestState) {
        try {
          this.updateFocusedAgentMemories();
          this.render(this.latestState);
        } catch (err) {
           this._errorCount += 5; // Penalty for crash
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
      
      // [FIX 7] Sparkline Data Array Mutation
      const subset = [...data].slice(-width); 
      
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
    // [FIX 5] Inverted Hunger/Social Bar Logic
    const safeValue = this.safeNumber(value, 0);
    const safeMax = this.safeNumber(max, 100);
    
    // Calculate raw percentage of max (e.g. Hunger 100/100 is 100%)
    let pct = Math.min(100, Math.max(0, (safeValue / safeMax) * 100));

    const barLength = 10;
    const filled = Math.round((pct / 100) * barLength);
    const empty = barLength - filled;
    
    let color = Dashboard.COLORS.GOOD;
    
    if (isInverted) {
        // High Value = Bad (e.g., Hunger)
        if (pct > 60) color = Dashboard.COLORS.BAD;
        else if (pct > 30) color = Dashboard.COLORS.WARN;
        // Else Good
    } else {
        // High Value = Good (e.g., Energy)
        if (pct < 30) color = Dashboard.COLORS.BAD;
        else if (pct < 60) color = Dashboard.COLORS.WARN;
    }
    
    return `${label.padEnd(7)}: {${color}}[${'|'.repeat(filled)}${'.'.repeat(empty)}]{/${color}} ${pct.toFixed(0).padStart(3)}%`;
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
      const locationNode = worldGraph.nodes[agent.locationId];
      const homeNode = worldGraph.nodes[agent.homeLocationId];
      const workNode = worldGraph.nodes[agent.workLocationId];
      
      let content = `{bold}${agent.name}{/bold} (ID: ${safeId.substring(0, 4)})\n`;

      // AGE & LIFECYCLE
      const ageDisplay = agent.age !== undefined ? agent.age : '?';
      const stageDisplay = agent.lifeStage ? agent.lifeStage.charAt(0).toUpperCase() + agent.lifeStage.slice(1) : 'Unknown';
      const sexDisplay = agent.sex ? (agent.sex === 'male' ? 'Male' : 'Female') : '?';
      content += `{yellow-fg}Age: ${ageDisplay}{/yellow-fg} | ${stageDisplay} | ${sexDisplay}\n`;
      
      // FAMILY
      const spouseName = agent.spouseId ? (this._agentNameMap.get(agent.spouseId) || 'Unknown') : null;
      const numChildren = (agent.childIds || []).length;
      let familyLine = '';
      if (spouseName) familyLine += `Spouse: {magenta-fg}${spouseName}{/magenta-fg}`;
      if (numChildren > 0) familyLine += `${spouseName ? ' | ' : ''}Children: ${numChildren}`;
      if (familyLine) content += familyLine + '\n';

      // POLITICAL
      if (agent.politicalParty) {
        const partyName = agent.politicalParty.charAt(0).toUpperCase() + agent.politicalParty.slice(1);
        const partyColor = agent.politicalParty === 'republican' ? 'red-fg' : agent.politicalParty === 'democrat' ? 'blue-fg' : 'white-fg';
        let polLine = `{${partyColor}}${partyName}{/${partyColor}}`;
        if (agent.politicalOffice && !agent.politicalOffice.startsWith('candidate')) {
          const officeTitle = this._getOfficeTitle(agent.politicalOffice);
          polLine += ` {magenta-fg}[${officeTitle}]{/magenta-fg}`;
        } else if (agent.politicalOffice?.startsWith('candidate')) {
          polLine += ` {yellow-fg}[Running]{/yellow-fg}`;
        }
        content += `Party: ${polLine} | Engagement: ${agent.politicalEngagement || 0}%\n`;
      }

      // JOB: Resolve Work Location Name
      let workName = agent.workLocationId || 'N/A';
      if (workNode) {
          workName = this.getRichLocationName(workNode);
      }
      content += `{blue-fg}${agent.job?.title || 'Unemployed'}{/blue-fg} @ ${workName}\n`;
      
      // CURRENT LOCATION: Resolve Rich Name + Borough
      let locStr = agent.locationId || 'Unknown';
      if (locationNode) {
          const borough = locationNode.borough ? ` (${locationNode.borough})` : '';
          const richName = this.getRichLocationName(locationNode); 
          locStr = `${richName}${borough}`;
      }
      content += `Location: {white-fg}${locStr}{/white-fg}\n`;

      // HOME: Resolve Rich Name
      let homeStr = agent.homeLocationId || 'Homeless';
      if (homeNode) {
          const borough = homeNode.borough ? ` (${homeNode.borough})` : '';
          const richName = this.getRichLocationName(homeNode);
          homeStr = `${richName}${borough}`;
      }
      content += `Home: ${homeStr}\n`;
      
      content += `Action: {cyan-fg}${this.getFormattedAction(agent)}{/cyan-fg}\n`;
      content += '\n';

      // PEOPLE NEARBY
      // Scan the agent cache for others in the same locationId
      const nearbyAgents = this.agentsInFocusCache.filter(a => 
          a.id !== agent.id && 
          a.locationId === agent.locationId
      );
      
      if (nearbyAgents.length > 0) {
          const names = nearbyAgents
              .slice(0, Dashboard.MAX_NEARBY_SHOWN)
              .map(a => a.name)
              .join(', ');
          const moreCount = nearbyAgents.length - Dashboard.MAX_NEARBY_SHOWN;
          const moreStr = moreCount > 0 ? ` +${moreCount} others` : '';
          content += `{bold}Nearby:{/bold} {green-fg}${names}${moreStr}{/green-fg}\n\n`;
      } else {
          content += `{bold}Nearby:{/bold} {grey-fg}None{/grey-fg}\n\n`;
      }

      content += `{bold}Vitals:{/bold}\n`;
      content += `  Money: $${Math.round(agent.money || 0)}\n`;
      content += `  Energy: ${this.formatNeed('Energy', agent.energy, 100, false)}\n`;
      content += `  Hunger: ${this.formatNeed('Hunger', agent.hunger, 100, true)}\n`;
      content += `  Social: ${this.formatNeed('Social', agent.social, 100, true)}\n`;
      if ((agent.boredom || 0) > 20) {
        content += `  Boredom:${this.formatNeed('Boredom', agent.boredom, 100, true)}\n`;
      }
      content += '\n';
      
      content += `{bold}Status:{/bold}\n`;
      const effects = agent.status_effects ?? [];
      let statusStr = '{green-fg}Normal{/green-fg}';
      if (effects.length > 0) {
          statusStr = effects.map(e => {
              const dur = e.duration ? `(${e.duration}t)` : '';
              let color = Dashboard.COLORS.WHITE;
              
              if (['SICK', 'GROGGY', 'LETHARGIC', 'EXHAUSTED', 'INJURED'].includes(e.type)) color = Dashboard.COLORS.BAD;
              else if (['WELL_FED', 'WELL_RESTED', 'CONNECTED', 'FLOWING', 'PREGNANT'].includes(e.type)) color = Dashboard.COLORS.BUFF;
              else if (['STRESSED', 'INSOMNIA', 'BURNOUT'].includes(e.type)) color = Dashboard.COLORS.WARN;
              else color = Dashboard.COLORS.WHITE; 
              
              return `{${color}}${e.type}{/${color}}${dur}`;
          }).join(', ');
      }
      content += `  ${statusStr}\n\n`;

      const skillsStr = this.getTopSkills(agent);
      if (skillsStr) {
          content += `{bold}Skills:{/bold} ${skillsStr}\n`;
      }

      const inventory = agent.inventory || [];
      if (inventory.length > 0) {
          const items = inventory.map(i => {
             const catalogItem = dataLoader.ITEM_CATALOG ? dataLoader.ITEM_CATALOG[i.itemId] : null;
             return catalogItem ? catalogItem.name : (i.itemId || i.type);
          });
          content += `{bold}Inv:{/bold} ${items.join(', ').substring(0, 50)}${items.join(', ').length > 50 ? '...' : ''}\n`;
      }

      const traits = this.getPersonalityTraits(agent);
      if (traits !== 'Average') {
          content += `{bold}Traits:{/bold} ${traits}\n`;
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
      const worldDateRaw = new Date(this.safeString(data.time));
      const displayDateUi = new Date(worldDateRaw);
      displayDateUi.setFullYear(1999);

      // FIX: Memory Leak - Clear cache periodically
      if (tick % 1000 === 0 && this.lastRenderedTick !== tick) {
          this._nodeCache.clear();
      }

      const getNode = (id) => {
          if (!id) return null;
          if (!this._nodeCache.has(id)) this._nodeCache.set(id, worldGraph.nodes[id]);
          return this._nodeCache.get(id);
      };

      // [PERF] Only rebuild sort/name-map/list when tick actually advances.
      // The render loop fires faster than the simulation tick, so intermediate
      // calls between ticks are no-ops for the expensive list path.
      if (tick !== this.lastRenderedTick) {
        // [FIX 9] Agent List Sort Mutates Cache
        this.agentsInFocusCache = [...agents].sort((a, b) => {
            const nameA = (a?.name || '').toLowerCase();
            const nameB = (b?.name || '').toLowerCase();
            if (nameA < nameB) return -1;
            if (nameA > nameB) return 1;
            return 0;
        });

        // [FIX 3] Agent Name Map Rebuild Logic Flaw
        // Rebuild map on each new tick to ensure fresh ID mapping
        this._agentNameMap.clear();
        agents.forEach(a => this._agentNameMap.set(a.id, a.name));
        this._lastAgentCount = agents.length;

        const nCache = this.agentsInFocusCache.length;
        if (nCache > 0) {
          this.autoCycleAgentIdx = Math.min(this.autoCycleAgentIdx, nCache - 1);
          const stillSelected = this.selectedAgentId
            && this.agentsInFocusCache.some(a => a.id === this.selectedAgentId);
          if (!stillSelected) {
            this.selectedAgentId = this.agentsInFocusCache[this.autoCycleAgentIdx]?.id ?? null;
          }
        }
      }

      const agentNameMap = this._agentNameMap;

      // Header
      try {
        const timeString = worldDateRaw.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const displayDate = displayDateUi;
        const lightLevel = this.safeNumber(worldState.environment?.globalLight, 0.5);
        const dayNightIcon = lightLevel > 0.4 ? '{yellow-fg}(Day){/yellow-fg}' : '{grey-fg}(Night){/grey-fg}';
        let totHunger = 0, totEnergy = 0, totSocial = 0;
        
        // [FIX 4] Division by Zero Protection
        const count = agents.length > 0 ? agents.length : 1; 
        
        agents.forEach(a => {
            totHunger += (100 - this.safeNumber(a.hunger, 0)); 
            totEnergy += this.safeNumber(a.energy, 0);         
            totSocial += (100 - this.safeNumber(a.social, 0)); 
        });
        
        const avgHunger = agents.length ? Math.round(totHunger / count) : 0;
        const avgEnergy = agents.length ? Math.round(totEnergy / count) : 0;
        const avgSocial = agents.length ? Math.round(totSocial / count) : 0;
        const avgNeeds = `Hunger:${this.makeBar(avgHunger, 100)} Energy:${this.makeBar(avgEnergy, 100)} Social:${this.makeBar(avgSocial, 100)}`;
        const lcStats = this.cacheManager?.lifecycleStats || {};
        const lcLine = `Born: ${lcStats.totalBirths || 0} | Died: ${lcStats.totalDeaths || 0} | Immigrated: ${lcStats.totalImmigrations || 0} | Emigrated: ${lcStats.totalEmigrations || 0}`;
        const obsIndicator = this.autoCycleMode
          ? ` | {yellow-fg}[OBS ${this.autoCycleSpeed}t]{/yellow-fg}`
          : '';
        this.headerBox.setContent(
          ` {cyan-fg}{bold}TIME:{/bold}{/cyan-fg} ${timeString} ${dayNightIcon} | ${displayDate.toDateString()}\n` +
          ` {cyan-fg}{bold}STATUS:{/bold}{/cyan-fg} Tick: ${tick} | Population: ${agents.length} | ${lcLine}${obsIndicator}\n` +
          ` {cyan-fg}{bold}NEEDS:{/bold}{/cyan-fg}  ${avgNeeds}\n` +
          ` {grey-fg}Keys: P pause | > fast | + normal | V profiler | C observer on/off | C-q quit{/grey-fg}`
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
          const we = worldState.world_events || [];
          const eventParts = we.map(formatWorldEventLine).filter(Boolean);
          let events = eventParts.join('; ');
          if (!events) events = pickWeightedAmbient(tick);
          const calendarLine = formatCalendarLine(displayDateUi);
          
          // [Refined] Look for rich description in dataLoader if worldState is simple
          let atmosphere = worldState.timeOfDayDesc || 'The city is quiet.';
          if (dataLoader.weatherPatterns && weather.weather && dataLoader.weatherPatterns[weather.weather]) {
               // Optionally use specific weather text if timeOfDayDesc is generic
               // atmosphere = dataLoader.weatherPatterns[weather.weather].description;
          }

          const cityStats = this.getCityEconomyStats();
          const civStats = this.getCivStats(agents);
          this.worldBox.setContent(
              `{bold}Weather:{/bold} ${weatherDesc}, ${temp}\n` +
              `{bold}Economy:{/bold} Avg Cash: $${cityStats.avgTreasury} | Infrastructure: ${cityStats.avgCondition}%\n` +
              `{bold}City Stats:{/bold} Homeless: ${civStats.homeless} | Unemployed: ${civStats.unemployed} | Sick: ${civStats.sick} | Top Job: ${civStats.topJob}\n` +
              `{bold}News:{/bold}    ${news}\n` +
              (calendarLine ? `${calendarLine}\n` : '') +
              `{bold}Events:{/bold}  ${events}\n` +
              `{bold}Vibe:{/bold}    ${atmosphere}`
          );
      } catch (err) {
          this.worldBox.setContent(`{red-fg}World Data Error{/red-fg}`);
      }

      // Agent List - only rebuild rows when tick has advanced
      if (tick !== this.lastRenderedTick) try {
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
            const ageStr = agent.age !== undefined ? `${agent.age}` : '?';
            const stageIcon = agent.lifeStage === 'child' ? '♦' : agent.lifeStage === 'teen' ? '◊' : agent.lifeStage === 'elder' ? '○' : '';
            const rawName = this.safeString(agent.name, 'UNKNOWN');
            const nameWithAge = `${rawName} ${ageStr}${stageIcon}`.padEnd(24).substring(0, 24);
            const nameStr = lodMarker + indicator + nameWithAge;
            const rawJob = this.safeString(this.safeGet(agent, 'job.title'), 'None').padEnd(20).substring(0, 20);
            const jobColor = this.getJobColor(rawJob);
            const jobStr = `{${jobColor}}${rawJob}{/${jobColor}}`; 
            const locDisplay = this.resolveAgentLocationDisplay(agent, getNode);
            const locName = locDisplay.name;
            const locType = locDisplay.type;
            
            const rawLoc = locName.padEnd(20).substring(0, 20);
            const locColor = this.getLocationColor(locType);
            const locStr = `{${locColor}}${rawLoc}{/${locColor}}`;
            
            // ACTIVITY (Category/High-Level State using Name from YAML if avail)
            let activityRaw = agent.currentActivityName || agent.state || 'idle';
            let activityDisplay = this.normalizeActivityDisplay(agent, activityRaw);
            
            const actStr = activityDisplay.padEnd(20).substring(0, 20);
            const actColor = this.getActivityColor(agent.state);
            
            // ACTION (Specific Detail from currentActivity or Intention)
            let actionText = this.safeString(agent.currentActivity, '');
            const actionIsBracket = /^\[[^\]]+\]$/.test(actionText.trim());

            // If currentActivity is just the state name/category, or empty, try to find a better description
            // This happens if the agent hasn't picked a specific action string yet
            if (!actionText || actionIsBracket || actionText === activityRaw || actionText.includes('fsm_')) {
                 const intention = agent.intentionStack && agent.intentionStack.length > 0 
                  ? agent.intentionStack[agent.intentionStack.length - 1] 
                  : null;
                 if (intention && intention.goal) {
                     // e.g. "Get Coffee"
                     let prettyGoal = intention.goal.replace('fsm_', '').replace(/_/g, ' ');
                     actionText = prettyGoal; 
                 } else {
                     actionText = '...';
                 }
            }
            
            const actionDetail = actionText.padEnd(45).substring(0, 45);
            const actionStr = `{${actColor}}${actionDetail}{/${actColor}}`;

            return `${nameStr}   ${jobStr}   ${locStr}   ${actStr}   ${actionStr}`;
          } catch (e) { return `ERR: ${agent?.id ? String(agent.id) : 'bad_id'}`; }
        });
        
        // [FIX 11] Optimize List Updates - Prevents Navigation Lock
        // Only update blessed list if content strings actually changed. 
        // Reduces overhead and prevents cursor reset/fighting during navigation.
        const currentSignature = listItems.join('|');
        if (currentSignature !== this._lastListSignature) {
            this.agentList.setItems(listItems);
            this._lastListSignature = currentSignature;
        }

      } catch (err) {
      }
      this.lastRenderedTick = tick;

      // Observer auto-cycle: advance to next simulant on schedule
      if (this.autoCycleMode && agents.length > 0) {
        const n = this.agentsInFocusCache.length;
        if (n > 0 && tick - this.autoCycleLastAgentTick >= this.autoCycleSpeed) {
          this.autoCycleAgentIdx = (this.autoCycleAgentIdx + 1) % n;
          this.selectedAgentId = this.agentsInFocusCache[this.autoCycleAgentIdx]?.id || null;
          this.autoCycleLastAgentTick = tick;
          this.updateFocusedAgentMemories();
          const idx = Math.min(this.autoCycleAgentIdx, n - 1);
          this._suppressSelectEvent = true;
          try {
            this.agentList.select(idx);
          } catch (e) {
            /* blessed list can throw on bad index */
          }
          this._suppressSelectEvent = false;
        }
      }

      // Agent Details
      try {
        const agent = this.selectedAgentId ? agents.find(a => a.id === this.selectedAgentId) : null;
        if (agent) {
          const obsLabel = this.autoCycleMode
            ? ` {yellow-fg}[OBS ${this.autoCycleSpeed}t]{/yellow-fg}`
            : '';
          this.agentDetailBox.setLabel(`{bold}[ ${agent.name} ]{/bold}${obsLabel}`);

          // Build relationship list
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

          const formattedDetails = this.formatAgentDetails(agent);
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
    const desc = m?.memory_text || m?.description || 'No description';
    return `- ${desc.substring(0, 40)}`;
}).join('\n') || 'None'}

{bold}Active Plans{/bold}
${(agent.plans && agent.plans.length > 0) ? agent.plans.map(p => `- Tick ${p.tick}: ${p.type}`).join('\n') : 'No plans'}`
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

      // Politics Panel
      try {
        const polState = data.politicalState;
        if (polState) {
          let polContent = '';

          const mayor = polState.officeholders?.mayor;
          if (mayor) {
            const approvalBar = this.makeBar(Math.round(mayor.approval), 100);
            const mayorPartyName = mayor.party ? mayor.party.charAt(0).toUpperCase() + mayor.party.slice(1) : 'Independent';
            const partyColor = mayor.party === 'republican' ? 'red-fg' : mayor.party === 'democrat' ? 'blue-fg' : 'white-fg';
            polContent += `{bold}Mayor:{/bold} ${mayor.name} {${partyColor}}(${mayorPartyName}){/${partyColor}} ${approvalBar}\n`;
          }

          const bpIds = ['bp_manhattan', 'bp_brooklyn', 'bp_queens', 'bp_bronx', 'bp_staten_island'];
          const bpLabels = { bp_manhattan: 'Manhattan', bp_brooklyn: 'Brooklyn', bp_queens: 'Queens', bp_bronx: 'Bronx', bp_staten_island: 'Staten Island' };
          for (const id of bpIds) {
            const bp = polState.officeholders?.[id];
            if (!bp) continue;
            const bpPartyName = bp.party ? bp.party.charAt(0).toUpperCase() + bp.party.slice(1) : 'Independent';
            const bpColor = bp.party === 'republican' ? 'red-fg' : bp.party === 'democrat' ? 'blue-fg' : 'white-fg';
            polContent += `{bold}${bpLabels[id]}:{/bold} ${bp.name} {${bpColor}}(${bpPartyName}){/${bpColor}}\n`;
          }

          const adv = polState.officeholders?.public_advocate;
          if (adv) {
            const advParty = adv.party ? adv.party.charAt(0).toUpperCase() + adv.party.slice(1) : 'Independent';
            const advColor = adv.party === 'republican' ? 'red-fg' : adv.party === 'democrat' ? 'blue-fg' : 'white-fg';
            polContent += `{bold}Public Advocate:{/bold} ${adv.name} {${advColor}}(${advParty}){/${advColor}}\n`;
          }
          const comp = polState.officeholders?.comptroller;
          if (comp) {
            const compParty = comp.party ? comp.party.charAt(0).toUpperCase() + comp.party.slice(1) : 'Independent';
            const compColor = comp.party === 'republican' ? 'red-fg' : comp.party === 'democrat' ? 'blue-fg' : 'white-fg';
            polContent += `{bold}Comptroller:{/bold} ${comp.name} {${compColor}}(${compParty}){/${compColor}}\n`;
          }

          if (polState.electionPhase === 'campaign' || polState.electionPhase === 'primary') {
            polContent += `{yellow-fg}{bold}CAMPAIGN SEASON{/bold}{/yellow-fg}`;
            const daysLeft = polState.termLength - polState.daysIntoTerm;
            polContent += ` (${daysLeft} days to election)\n`;
          } else if (polState.electionPhase === 'transition') {
            polContent += `{green-fg}{bold}ELECTION DAY{/bold}{/green-fg}\n`;
          } else {
            const daysLeft = polState.termLength - polState.daysIntoTerm;
            polContent += `Next election in ${daysLeft} days\n`;
          }

          if (polState.news && polState.news.length > 0) {
            const latest = polState.news[polState.news.length - 1];
            polContent += `{grey-fg}${latest.substring(0, 55)}${latest.length > 55 ? '...' : ''}{/grey-fg}`;
          }

          this.politicsBox.setContent(polContent);
        }
      } catch (err) {
        this.politicsBox.setContent(`{red-fg}Politics Error{/red-fg}`);
      }

      // Profiler update
      if (this.viewMode === 'profiler' && eventBus && typeof eventBus.getEventProfile === 'function') {
          const profile = eventBus.getEventProfile();
          let profilerContent = `{bold}Total Events Processed: {green-fg}${profile.totalEventsProcessed}{/green-fg}{/bold}\n\n`;
          profilerContent += `{bold}Event Counts:{/bold}\n`;
          
          const sortedEvents = Object.entries(profile.counts)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 15);
              
          for (const [evtName, count] of sortedEvents) {
              profilerContent += ` - ${evtName.padEnd(25)} : {yellow-fg}${count}{/yellow-fg}\n`;
          }
          this.profilerBox.setContent(profilerContent);
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
      
      this.screen.key(['p', 'P'], () => {
          eventBus.emitNow('system:pause');
      });
      
      this.screen.key(['>'], () => {
          eventBus.emitNow('system:speed', 4); // Fast forward
      });
      
      this.screen.key(['+'], () => {
          eventBus.emitNow('system:speed', 1); // Normal speed
      });
      
      this.screen.key(['v', 'V'], () => {
          this.viewMode = this.viewMode === 'logs' ? 'profiler' : 'logs';
          if (this.viewMode === 'logs') {
              this.profilerBox.hide();
              this.logBox.show();
          } else {
              this.logBox.hide();
              this.profilerBox.show();
          }
          this.screen.render();
      });

      this.screen.key(['c', 'C'], () => {
          this.autoCycleMode = !this.autoCycleMode;
          if (this.autoCycleMode) {
              this.autoCycleSpeed = AUTO_CYCLE_INTERVAL_TICKS;
              const n = this.agentsInFocusCache.length;
              if (n > 0) {
                  const curIdx = this.agentsInFocusCache.findIndex(a => a.id === this.selectedAgentId);
                  this.autoCycleAgentIdx = Math.min(curIdx >= 0 ? curIdx : 0, n - 1);
              } else {
                  this.autoCycleAgentIdx = 0;
              }
              const t = this.latestState?.tick;
              this.autoCycleLastAgentTick = t !== undefined && t !== null ? this.safeNumber(t, 0) : 0;
          }
          if (this.latestState) this.render(this.latestState);
      });

      this.agentList.on('select item', (item, idx) => {
          try {
            // Manual selection cancels observer mode (but not programmatic cycle advances)
            if (this.autoCycleMode && !this._suppressSelectEvent) {
                this.autoCycleMode = false;
            }
            this.selectedAgentId = this.agentsInFocusCache[idx]?.id || null;
            this.updateFocusedAgentMemories();
            // Programmatic select runs inside render(); nested render() re-runs auto-cycle and can crash.
            if (this._suppressSelectEvent) return;
            if (this.latestState) {
                this.render(this.latestState);
            }
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
      eventBus.on('log:world', msg => safeLog(msg, 'magenta-fg'));
      eventBus.on('log:info', msg => safeLog(msg, 'green-fg'));
      eventBus.on('log:system', msg => safeLog(msg, 'yellow-fg'));

      eventBus.on('agent:born', data => safeLog(`♦ BORN: ${data.childName}`, 'green-fg'));
      eventBus.on('agent:died', data => safeLog(`✝ DIED: ${data.name} (${data.age}y) - ${data.cause}`, 'red-fg'));
      eventBus.on('agent:married', data => safeLog(`♥ MARRIED: ${data.names}`, 'magenta-fg'));
      eventBus.on('agent:divorced', data => safeLog(`÷ DIVORCED`, 'yellow-fg'));
      eventBus.on('agent:pregnant', data => safeLog(`♦ PREGNANT: ${data.name}`, 'cyan-fg'));
      eventBus.on('agent:immigrated', data => safeLog(`MOVED TO THE CITY: ${data.name} (${data.age}y)`, 'green-fg'));
      eventBus.on('agent:emigrated', data => safeLog(`MOVED AWAY: ${data.name} (${data.age}y)`, 'yellow-fg'));
      eventBus.on('agent:lifeStageChanged', data => safeLog(`↑ ${data.name} is now a ${data.newStage} (${data.age}y)`, 'cyan-fg'));

      eventBus.on('politics:electionAnnounced', () => safeLog('★ CAMPAIGN SEASON BEGINS', 'magenta-fg'));
      eventBus.on('politics:candidateDeclared', data => safeLog(`★ ${data.name} declares for ${data.office} (${data.party})`, 'magenta-fg'));
      eventBus.on('politics:electionResult', data => safeLog(`★ ELECTED: ${data.winner} wins ${data.office} (${data.margin}%)`, 'green-fg'));
      eventBus.on('politics:scandal', data => safeLog(`★ SCANDAL: ${data.headline?.substring(0, 60) || data.candidate}`, 'red-fg'));
      eventBus.on('politics:rally', data => safeLog(`★ RALLY: ${data.headline?.substring(0, 60) || data.candidate}`, 'yellow-fg'));
      eventBus.on('politics:inauguration', data => safeLog(`★ INAUGURATED: ${data.name} as ${data.office}`, 'cyan-fg'));
  }
}

export default Dashboard;