# NYX-99

> A terminal-based idle civilization simulator. Ten thousand lives play out in real time — eating, sleeping, working, falling in love, getting mugged, and voting — all inside your terminal while you watch.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ [ Architect's Console ]                     [ World & Activity ]        │
│  TIME: 11:42 PM (Night) | Thu Jan 14 1999   Weather: Light rain, 16°C  │
│  STATUS: Tick: 4821 | Population: 5000 |    Infrastructure: 78.3%      │
│          Immigrated: 142 | Emigrated: 31    City Stats: Homeless: 12   │
│  NEEDS: Hunger:[|||||||...] Energy:[|||||...] Social:[||||||||..]       │
├──────────────────────────────────────────────────────────────────────────┤
│ [ Simulant List (All) ]                     [ Agent Details ]           │
│     NAME/AGE           CAREER    LOCATION   │  Maria Santos 31          │
│  █  Maria Santos 31   Nurse     St. Luke's  │  Party: Democrat          │
│     James Park 44     Banker    Midtown     │  Engagement: 72%          │
│  ‼  Keisha Brown 22   Bartender East Vill.  │  Nurse @ St. Luke's       │
│     Tom Walsh 67○     Retired   Astoria     │  Location: St. Luke's     │
│     Ana Diaz 19◊      Barista   Flatbush    │  Action: Working night    │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## What is this

NYX-99 is a headless-capable Node.js simulation that runs a living city. Each simulant has needs, a job, a home, relationships, political opinions, and a memory. They make decisions every 15 simulated minutes. They age, marry, have children, get evicted, run for office, and die — without any input from you.

It is not a game. There is no objective. You watch.

---

## Features

### Autonomous agents
Each simulant runs a full behavior tree and finite state machine. They balance hunger, energy, social needs, boredom, stress, and mood. When needs conflict, a utility scorer weighs them against personality and circumstance.

**Life stages** — child, teen, adult, elder — each with distinct behavior patterns. Children have higher boredom decay. Elders face illness multipliers and draw pensions. Teens earn part-time wages.

**13 distinct FSM states** including working, sleeping, socializing, shopping, commuting, desperate survival, acquiring housing, and retirement.

### Economy
Agents earn salaries on a weekly payroll cycle. Businesses hold their own treasury and pay workers from it — a business with a failing treasury bounces paychecks. Agents pay monthly rent. Failure to pay three months in a row triggers eviction and homelessness.

Rent creeps up or stabilizes based on the mayor's housing policy stance.

### Social fabric
When two agents share a location in the socializing state, they pair up and have a conversation. Topics are drawn from a 1999 cultural database (Napster, Y2K, the Knicks, rent prices). Shared interests create bonding events; mismatched political opinions create friction. Affinity tracks over time and gates relationship types from stranger to acquaintance to friend to romantic partner. Partners can move in together.

### Generational life cycle
Agents are born, grow up, find work, form families, and die. The population self-regulates via immigration (new agents arrive) and emigration (agents with severe mood debt leave the city). Death rates are age-stratified. Children inherit their parent's last name.

### Political system
A full election cycle runs continuously. Candidates declare, hold rallies, endure scandals, get endorsed, and face general elections. Agents vote based on issue alignment, party loyalty, and personal relationships with candidates.

The elected mayor's positions have mechanical consequences:

| Mayor stance | Effect |
|---|---|
| Tough on crime | Reduces mugging probability by up to 30% |
| Pro-transit | Reduces subway delay frequency |
| Pro-market housing | Rent drifts upward each month |
| Pro-tenant housing | Rent remains stable or falls |

Agents who get mugged, evicted, or lose jobs shift their political opinions accordingly. Those opinions feed into the next election. The loop closes.

### 1999 historical events
Scripted world events fire based on simulated date:

- **February** — Amadou Diallo aftermath: weekly protest headlines, citywide `crime_policing` opinion drift, amplified in the Bronx
- **April–December** — Y2K preparation: escalating anxiety headlines, transit opinion pressure
- **October** — Brooklyn Museum "Sensation" controversy: Giuliani vs. art world, cultural politics drift
- **May–September** — MTA fare hike debate: transit opinion drift across all boroughs

### Accidents and illness
Agents can be mugged, injured at work, catch the flu, break a bone, or be caught in an apartment fire. Illness duration is tracked in ticks. Elders face a 2× illness multiplier. Being mugged immediately shifts political opinions on crime and quality of life.

### World simulation
Weather changes daily from a weighted pattern set. Time of day affects needs decay (hunger spikes at meal hours, energy drains faster at night). Subway delays spawn as random events and generate contextual news headlines. Infrastructure degrades based on occupancy. Sensory events (sounds, smells) fire based on location type and weather.

### Terminal dashboard
A live `blessed`-powered TUI with six panels:

- **Architect's Console** — time, population, lifecycle stats, aggregate needs
- **World & Activity** — weather, economy, city stats, news headline, active events
- **Simulant List** — all agents sorted alphabetically with job, location, activity, and need indicators
- **Agent Details** — selected agent's full profile, vitals, relationships, memories, plans, and political opinions
- **City Politics** — current officeholders, approval ratings, election countdown
- **System Log** — live event feed: births, deaths, marriages, scandals, elections, accidents

---

## Controls

| Key | Action |
|-----|--------|
| `↑` / `↓` | Select agent from list |
| `C` | Toggle Observer Mode (cycles through all agents automatically) |
| `C` again | Switch observer speed: 60 ticks → 600 ticks → off |
| `P` | Pause / resume simulation |
| `>` | Fast forward (4× speed) |
| `+` | Return to normal speed |
| `V` | Toggle Event Profiler overlay |
| `Ctrl-Q` | Quit |

### Observer Mode
Pressing `C` activates a passive watch mode. The dashboard automatically advances to the next agent every 60 simulated ticks (about 15 minutes of sim-time) and rotates through four focused detail pages every 10 ticks:

1. Identity, job, location, action, nearby agents
2. Vitals and emotional state with sparklines
3. Relationships, skills, inventory
4. Memories, active plans, political profile

Press `C` again to switch to slow mode (600 ticks per agent). Press once more to return to manual control.

---

## Getting started

**Requirements:** Node.js 18+

```bash
git clone <repo>
cd modern
npm install
npm start
```

To set agent count:

```bash
node index.js --agents=10000
```

To run without the TUI (headless, for servers or logging):

```bash
node index.js --headless
```

---

## Configuration

### Agent count and tick rate

Set via environment variables or command-line flags:

```bash
INITIAL_AGENTS=8000 TICK_RATE_MS=2000 npm start
```

| Variable | Default | Description |
|---|---|---|
| `INITIAL_AGENTS` | `5000` | Agents spawned at startup |
| `TARGET_POPULATION` | `1000` | Long-term population the lifecycle system stabilizes toward |
| `TICK_RATE_MS` | `3000` | Real milliseconds between simulation ticks |
| `MINUTES_PER_TICK` | `15` | Simulated minutes each tick advances |

### Performance tuning

For large populations, disable verbose logging to cut tick time:

```bash
DISABLE_ALL_THINKING=true \
LOG_ALL_ACTION_SCORES=false \
LOG_ALL_SOCIALS_TO_MEMORY=false \
node index.js --agents=20000
```

### Game balance

All tuning constants live in [`data/balance.js`](data/balance.js) — needs decay rates, emotional thresholds, economic costs, lifecycle probabilities, and political weights. The file is annotated; change numbers there and restart.

All world content (jobs, names, locations, weather, events, political offices, dialogue topics, 1999 slang) lives in the `data/` YAML files and can be edited without touching code.

---

## Architecture

```
index.js                    Entry point, graceful shutdown
engine/
  matrix.js                 Main loop, worker orchestration, tick dispatch
  agent.js                  Agent class, needs, relationships, memory
  fsm.js                    Finite state machine + A* pathfinding
  fsmStates/                13 behavioral states (working, sleeping, socializing, ...)
  BehaviorTreeCore.js       Selector / Sequence / Condition / Action nodes
  worldSeeder.js            Initial world population and relationship seeding
  worldPartitioner.js       Geographic partition assignment for workers
services/
  agentService.js           Per-tick agent update dispatch
  socialService.js          Paired conversation resolution, political friction
  lifecycleService.js       Births, deaths, aging, accidents, illness
  worldService.js           Weather, news, rent, degradation, policy multipliers
  politicsService.js        Elections, opinion drift, timed historical events
  perceptionService.js      Agent sensory awareness of surroundings
data/
  balance.js                All numeric tuning constants
  config.js                 System configuration (tick rate, DB path, logging flags)
  *.yaml                    World content: demographics, locations, culture, politics, ...
workers/
  agent.worker.js           Worker thread: hydrates agents, runs FSM, social logic
ui/
  dashboard.js              Blessed TUI: all six panels, observer mode, keybindings
```

Workers are spawned via `worker_threads`, one per logical CPU minus one (reserved for the main thread). Each worker owns a geographic partition of the world graph and processes the agents currently in its territory. The main thread handles world-level services, the database, and the dashboard.

---

## Scale reference

Tested on a single machine. Bottleneck is IPC serialization (agent data round-trips between main thread and workers every tick), not raw compute.

| Agents | Experience |
|---|---|
| 1,000–5,000 | Effortless. Default range. |
| 5,000–12,000 | Comfortable. Ticks complete well within the 3s window. |
| 12,000–20,000 | Workable. Occasional adaptive pacing. |
| 20,000–30,000 | Pushing limits. Checkpoint writes become noticeable. |

On an 8-core machine with a large L3 cache, 10,000–15,000 agents is a good target.
