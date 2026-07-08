# NYC 1999 Feature Inventory

This file captures the current feature surface before simplification work. Treat it as the no-regression checklist for future refactors: removing or changing one of these behaviors should require an explicit backlog card and acceptance criteria.

## Runtime Modes

- Start the simulation with `npm start` or `node index.js`.
- Override initial population with `--agents=N`.
- Run without the terminal UI using `--headless`.
- Enable debug mode with `--debug`.
- Show help with `--help`.
- Graceful shutdown persists dirty agents and creates a checkpoint.
- Headless mode supports keyboard shortcuts:
  - `q`: quit.
  - `s`: manual save.
  - `d`: toggle event bus debug logging.

## Simulation Time

- The simulation starts at `1999-01-01T08:00:00`.
- Time advances by `MINUTES_PER_TICK`.
- The default loop pace comes from `TICK_RATE_MS`.
- The engine supports pause and speed changes through dashboard events.
- Adaptive pacing slows the loop when ticks lag and recovers toward the base tick rate when healthy.

## Population

- Initial agent count is configurable.
- Target population is configurable.
- Agents can be loaded from checkpoints or generated fresh.
- Agents have stable IDs, names, age, life stage, home, job, money, needs, mood, stress, burnout, relationships, inventory, memories, routines, and political identity fields.
- The system supports thousands of agents through worker-thread partitioning.
- Worker partitions are based on location and can rebalance over time.

## Agent Needs And Emotional State

Agents currently track:

- Hunger.
- Energy.
- Social connection.
- Boredom.
- Stress.
- Mood.
- Burnout.

Need and emotion behavior includes:

- Passive decay through state ticks.
- Circadian hunger and energy multipliers.
- Weather/temperature effects on energy decay.
- Sickness effects on energy decay.
- Social decay affected by crowding and extroversion.
- Stress penalties for low energy, high hunger, low social, noise, crowds, and financial pressure.
- Mood spiral when stress crosses configured thresholds.
- Status effects with durations and stat multipliers.
- History buffers for mood, energy, stress, and money.

## Agent FSM States

The simulation supports these agent states and aliases:

- Idle and idle variants.
- Sleeping.
- Eating.
- Desperate/survival mode.
- Shopping.
- Socializing.
- Recreation.
- Maintenance.
- Acquire housing.
- Commuting/in transit.
- Working and work-category aliases.
- Retired.

State behavior includes:

- Critical exhaustion interruption into sleeping.
- Critical starvation interruption into desperate mode.
- State history for recent transitions.
- Pending state transitions to guard against recursive transitions.
- Per-state `enter`, `tick`, and `exit` hooks.
- Behavior-tree actions and conditions for state decisions.

## Daily Routine And Work

- Agents have work schedules (`workStartHour`, `workEndHour`, `workDays`).
- Work dispatch happens from idle when shift and routine gates allow it.
- Agents can commute to a work location.
- Jobs map to working activity tags such as office, police, teacher, service, and student.
- Work activities resolve through `activities.yaml` tags and current location type.
- Work sessions can pay wages.
- Working agents can take lunch breaks.
- Burnout and slack behavior are represented in work state logic.
- Morning routine/pre-work behavior is represented in idle state logic.

## Commuting And Location Movement

- `worldGraph` stores nodes and edges from `location_graph.yaml`.
- Agents have `locationId`, `homeLocationId`, and work/target location fields.
- Commuting uses pathfinding and hop-by-hop travel timers.
- Subway fare data can be derived from economy prices.
- Location density is calculated every tick.
- Location peer maps provide same-location context for perception/social systems.
- Dynamic partition rebalancing uses location density and ownership.

## Housing

- Agents can have homes with rent costs.
- Homeless agents can enter acquire-housing behavior.
- Housing search and home maintenance are separate FSM behaviors.
- Departure cleanup handles family/social references for agents who die or leave.

## Inventory And Items

- Agents have an inventory object.
- Item helpers support consumable food, item consumption, and hobby-item checks.
- Runtime item catalog currently includes food, tools, apparel, gifts, and energy drink items.
- Items can have cost, type, energy boost, hunger reduction, skill/social modifiers, uses, and tags.
- Shopping behavior can purchase inventory items.

## Social Simulation

- Agents maintain relationship maps with affinity/score/type/history fields.
- Agents can socialize in person or digitally.
- Social interactions can affect mood, memories, and relationships.
- Agents perceive nearby agents through same-location peer data.
- Relationship cleanup keeps departed agents as memory entries with departure metadata.
- Social thoughts and milestone logging are configurable.

## Memory And Thoughts

- Agents have short-term memory and history/memory-oriented fields.
- `dbService.js` persists memories.
- Thought logging is controlled by config flags for decisions, transitions, actions, needs, social, travel, and finance.
- LOD and debug-agent filters limit thought spam.
- Memories can be written during critical events and social/financial interactions.

## Lifecycle Simulation

Lifecycle service supports:

- Aging.
- Natural death.
- Accidents and illness.
- Pregnancy.
- Birth.
- Marriage.
- Divorce.
- Immigration.
- Emigration.
- Family relationship cleanup.
- Periodic departure sanitizer for dangling references.

## Politics

Political data supports:

- Parties.
- Offices.
- Mayor and borough-level offices.
- Campaigns.
- Initial officeholders.
- Agent political identity and opinions.
- Political engagement and voting history.
- Political state display in the dashboard.
- Politics tick processing and world-state multipliers.

## World Simulation

World systems include:

- Weather patterns.
- World/environment state (`globalLight`, `globalTemp`, weather, time of day).
- Economy status.
- Business treasuries.
- Rent and infrastructure/condition changes.
- News and ambient city status lines.
- Calendar events.
- Random street, subway, bar, and world events.
- Dynamic affordance modifiers from events.
- Crowd schedules by location type.

## Data-Driven Content

Runtime-loaded YAML content includes:

- Agent demographics, names, jobs, education, interests, and personality data.
- Location names.
- Economy prices.
- Culture data.
- Events.
- Location graph.
- Activities.
- Crowd schedules.
- Weather patterns.
- Dialogue phrase library.
- Politics.

Important activity invariant:

- FSM activity tags must match tags in `data/activities.yaml`.
- Activity location types must include the agent's current node type or `any`.
- If no valid activity is found, agents can fall back to bracketed activity labels, which should be treated as a data coverage issue.

## Dashboard

The terminal dashboard currently supports:

- Architect console header.
- World/activity panel.
- Agent list.
- Agent detail/inspector panel.
- Politics panel.
- System log.
- Event profiler toggle.
- Observer auto-cycle mode.
- Pause, fast-forward, and normal speed controls.
- Graceful shutdown controls.
- Color-coded vitals and state display.
- Relationship, memory, plan, inventory, and nearby-agent summaries.
- Mood/energy/stress/money sparklines.
- Calendar and ambient event display.

Dashboard keybindings:

- `P`: pause.
- `>`: fast-forward.
- `+`: normal speed.
- `V`: toggle logs/profiler.
- `C`: toggle observer auto-cycle.
- `Ctrl+Q` or `Ctrl+C`: shutdown.

## Persistence And Logging

- SQLite runtime persistence through `better-sqlite3`.
- Agent state sync.
- Checkpoints.
- Memory persistence.
- Simulation events.
- WAL-style operations.
- DB health checks and reconnection attempts.
- Corruption quarantine by renaming the database file.
- Debug and error log files through Winston.
- Optional console logging in headless mode.

## Performance And Scale Features

- Worker-thread agent processing.
- Location-based worker partitions.
- Worker health tracking, timeouts, respawn, and failure circuit breaker behavior.
- Worker stdout/stderr piping to parent logger in TUI mode.
- Graph snapshot/copy-on-write concepts.
- Event bus queue processing and history/profiling caps.
- Engine profiling toggles.
- UI render loop decoupled from simulation tick.
- Agent list update signatures to avoid unnecessary blessed list resets.

## Partial Or Disconnected Features

These exist in the repo but are not fully integrated with the current `npm start` path:

- `docker-compose.yml` provides Postgres, Redis, and pgAdmin services.
- `db/schema.sql` defines a Postgres/PostGIS/Timescale schema.
- `scripts/genesis.js` seeds a procedural Postgres world but imports `pg`, which is not declared in `package.json`.
- `data/world_data.yaml` is only used by `scripts/genesis.js`, not by runtime `dataLoader.js`.
- `data/sensory.yaml` is not loaded by runtime `dataLoader.js`.
- `config.env` is not automatically loaded because dotenv is not initialized.

## Known Behavioral Risks To Preserve For Review

These are not features to preserve; they are current behaviors to explicitly test or correct later:

- Worker and fallback update paths do not behave the same.
- Biological decay is duplicated across `Agent._decayStats()` and `BaseState.tick()`.
- Worker IPC does not merge every serialized field back into main-thread agents.
- Dashboard inventory display looks up `dataLoader.ITEM_CATALOG`, but `ITEM_CATALOG` is exported separately.
- Dead/stub code may still be referenced by comments or fallback paths.
