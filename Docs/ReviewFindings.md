# NYC 1999 Review Findings

This document captures findings from the documentation-only code review. No behavior changes are included here. Each finding is backlog-ready and should be converted into a kanban card.

Severity scale:

- Critical: likely correctness/data-loss/security issue.
- High: major simplification, robustness, or scale blocker.
- Medium: maintainability, tooling, or smaller correctness issue.
- Low: cleanup or documentation hygiene.

## Engine Core

### REV-001: Worker and fallback agent update paths have behavioral drift

- Severity: Critical.
- Type: Correctness.
- Files: `engine/matrix.js`, `engine/agent.js`, `services/agentService.js`, `engine/fsmStates/BaseState.js`.
- Evidence: `Matrix.tick()` uses workers when available but calls `agent.update()` directly when the worker pool is empty. `agent.update()` applies `_decayStats()`, sleep energy recovery, and `_processSenses()` before `fsm.tick()`. Worker updates call `agentService.updateAgent()`, which relies on `BaseState.tick()` for decay and uses `runPerception()`.
- Risk: Headless/fallback behavior can diverge from normal worker behavior, making bugs hard to reproduce and causing different need, sleep, transit, and perception outcomes.
- Acceptance criteria: One authoritative agent update path exists, or fallback delegates to the same update service used by workers. A regression test proves worker and fallback updates produce equivalent results for representative states.

### REV-002: Biological decay is duplicated and semantically inconsistent

- Severity: Critical.
- Type: Correctness.
- Files: `engine/agent.js`, `engine/fsmStates/BaseState.js`, `services/agentService.js`.
- Evidence: `Agent._decayStats()` adds to `social`, while `BaseState.tick()` subtracts from `social` and documents social as a positive connection/battery value. The fallback path can run both models.
- Risk: Agents can behave differently depending on update path and may regress into need/death-spiral issues.
- Acceptance criteria: There is one biological decay implementation with documented stat semantics. `social` meaning is explicit and used consistently. Tests cover hunger, energy, social, boredom, stress, and sleeping/eating overrides.

### REV-003: Worker IPC serializes fields that are not merged back

- Severity: Critical.
- Type: Correctness.
- Files: `workers/agent.worker.js`, `engine/cacheManager.js`.
- Evidence: Worker serialization includes `shortTermMemory`, `plans`, `intentionStack`, and `stateContext`; merge logic updates only some scalar/complex fields and omits important serialized state such as `stateContext`, `shortTermMemory`, and `plans`.
- Risk: Main-thread dashboard/persistence state can be stale. Conversations, commute/work state, plans, and memory queues can be lost or misrepresented.
- Acceptance criteria: Worker serialization and merge coverage are generated from a shared allowlist or tested contract. Every serialized field is intentionally merged or intentionally excluded with a comment and test.

### REV-004: `Matrix` is a god object

- Severity: High.
- Type: Simplification.
- Files: `engine/matrix.js`.
- Evidence: `Matrix` owns data loading, DB, cache, dashboard, event bus, worker pool lifecycle, worker health/circuit breaker, partition rebalancing, graph snapshots, adaptive pacing, lifecycle/politics/world service orchestration, tick cadence, persistence cadence, shutdown, and dashboard events.
- Risk: Large blast radius for changes; difficult testing; harder scaling work.
- Acceptance criteria: Extract at least worker-pool orchestration, persistence scheduling, and tick-world-service orchestration behind small interfaces without changing behavior. Existing tick pipeline remains observable and documented.

### REV-005: Global mutable state hides dependencies

- Severity: High.
- Type: Best practice.
- Files: `engine/matrix.js`, `index.js`, `ui/dashboard.js`.
- Evidence: Runtime sets `global.SimulationError`, `global.eventBus`, `global.cacheManager`, `global.dashboard`, `global.currentTick`, and `global.worldTime`.
- Risk: Harder tests, hidden coupling, accidental dependency on initialization order.
- Acceptance criteria: Document all globals and replace at least high-traffic globals with explicit constructor/service dependencies where practical. New code should not add globals.

### REV-006: FSM alias registry is confusing and partially inconsistent

- Severity: Medium.
- Type: Simplification.
- Files: `engine/fsm.js`.
- Evidence: The registry maps many aliases to new state instances; comments discuss singleton/flyweight behavior but some aliases instantiate separate objects. State names in instances can differ from alias names.
- Risk: Debugging/history can misreport state identity; aliases make future behavior-tree work harder.
- Acceptance criteria: Define canonical states and alias mapping separately. Tests prove aliases normalize to the intended state and preserve debug-friendly state names.

### REV-007: Job-title to work-tag mapping is fragile string matching

- Severity: Medium.
- Type: Simplification.
- Files: `engine/agentUtilities.js`, `engine/fsmStates/WorkingState.js`, `data/activities.yaml`.
- Evidence: `getWorkingTagForJobTitle()` uses an ordered chain of `includes()` checks, where order matters for titles such as designer variants.
- Risk: New jobs can map to the wrong activity tag and fall back to bracket labels if YAML tags/location types are not aligned.
- Acceptance criteria: Move job category/tag mapping to data or a tested table. Add tests for representative jobs and confirm every emitted `fsm_working_*` tag exists in `activities.yaml`.

### REV-008: Dead/stub engine code adds noise and false affordances

- Severity: Medium.
- Type: Simplification.
- Files: `engine/agent.js`, `engine/fsm.js`, `engine/cacheManager.js`, `engine/structures/PriorityQueue.js`, `services/agentService.js`.
- Evidence: `_processSenses()`, `_updateStatusEffectsStub()`, `updateRoutineReinforcement()`, `FiniteStateMachine.clearPathCache()`, unused `LOD2_TICK_INTERVAL` import, unused `PriorityQueue`, and dead `agent.inTransit/_handleMovement` branch.
- Risk: Future work may build on dead branches or assume features exist.
- Acceptance criteria: Remove or implement each stub. For retained placeholders, add a backlog-linked comment and test/usage.

## FSM States And Behavior Trees

### REV-009: `IdleState` is the central decision hub and is too broad

- Severity: High.
- Type: Simplification.
- Files: `engine/fsmStates/IdleState.js`.
- Evidence: Idle handles plan execution, homelessness, need scoring, work dispatch, morning routine, house maintenance, go-home behavior, groceries, planned outings, boredom, and default idle flavor.
- Risk: Most behavior changes touch one large file; ordering bugs are likely.
- Acceptance criteria: Extract decision helpers into focused modules or policies while preserving current behavior order. Add tests for priority order: plan, housing, critical needs, morning routine, maintenance, go-home, groceries, outings, boredom, idle.

### REV-010: State files repeat behavior-tree boilerplate

- Severity: Medium.
- Type: Simplification.
- Files: `engine/fsmStates/*.js`, `engine/BehaviorTreeCore.js`.
- Evidence: Most states define local `Actions`, `Conditions`, tree construction, `enter`, `tick`, and the same `super.tick()` plus transition return handling.
- Risk: Repeated patterns make fixes easy to miss and keep state behavior harder to scan.
- Acceptance criteria: Introduce a small shared helper for standard state tick/tree execution, or document why each state differs. Do not abstract state-specific behavior prematurely.

### REV-011: State context has no ownership model

- Severity: High.
- Type: Correctness.
- Files: `engine/fsm.js`, `engine/fsmStates/*.js`, `engine/cacheManager.js`, `workers/agent.worker.js`.
- Evidence: States store flat keys on `agent.stateContext`; FSM cleanup deletes namespaced keys that states generally do not use. Worker IPC does not merge `stateContext`.
- Risk: Context values can leak across states, disappear across IPC, or be ineffectively cleaned up.
- Acceptance criteria: Define a context ownership convention, either flat with explicit lifecycle or namespaced by state. Add tests around work session flags, social conversation state, shopping plans, and commute context.

### REV-012: State logging uses direct console calls

- Severity: Low.
- Type: Best practice.
- Files: `engine/fsmStates/*.js`, `ui/dashboard.js`, `logger.js`.
- Evidence: Several FSM states use `console.log()` for LOD1 flavor. Dashboard hooks console output, but direct logs from workers still need parent piping to avoid corrupting the TUI.
- Risk: UI/logging behavior stays fragile.
- Acceptance criteria: Route state flavor through `eventBus` or logger consistently. Dashboard console interception remains a fallback, not a primary path.

### REV-013: `AcquireHousingState` passes an ignored decay override

- Severity: Low.
- Type: Cleanup.
- Files: `engine/fsmStates/AcquireHousingState.js`, `engine/fsmStates/BaseState.js`.
- Evidence: `super.tick(agent, hour, localEnv, worldState, { decay: true })` passes an override key not consumed by `BaseState`.
- Risk: Misleading intent.
- Acceptance criteria: Remove the unused override or implement the intended behavior with a documented option.

## Services, Workers, Persistence

### REV-014: Inline DB worker code uses `{ eval: true }`

- Severity: High.
- Type: Security.
- Files: `dbService.js`.
- Evidence: Backup and recovery workers are built as inline strings and launched with `new Worker(workerCode, { eval: true })`.
- Risk: Larger attack surface and poorer static analysis, even if current inputs are local/trusted.
- Acceptance criteria: Move worker code into dedicated files under `workers/` and pass only validated worker data. Add tests for backup/recovery worker message handling if feasible.

### REV-015: Checkpoint and agent JSON deserialization lacks schema validation

- Severity: High.
- Type: Security/robustness.
- Files: `dbService.js`, `engine/cacheManager.js`, `engine/agent.js`, `engine/agentUtilities.js`.
- Evidence: Runtime uses `JSON.parse()` on DB rows/checkpoints/WAL data with fallbacks but no structural validation of fields, ranges, or allowed states.
- Risk: Corrupt or malformed persisted state can silently create invalid agents, bad states, or impossible needs.
- Acceptance criteria: Add lightweight validators for persisted agent state, checkpoint payloads, WAL rows, and known enum-like fields. Invalid records should be quarantined or reported with actionable logs.

### REV-016: Agent transit handling references fields/methods not present on `Agent`

- Severity: Medium.
- Type: Cleanup/correctness.
- Files: `services/agentService.js`, `engine/agent.js`, `engine/fsmStates/CommutingState.js`.
- Evidence: `agentService` checks `agent.inTransit` and calls `agent._handleMovement()`, but commute behavior is implemented through `CommutingState` and `travelTimer`.
- Risk: Dead code obscures actual commute behavior and can trigger partial decay behavior if `travelTimer` is present.
- Acceptance criteria: Consolidate movement handling under the commute state or implement the missing movement API. Add a commute test.

### REV-017: Domain services keep module-level mutable state

- Severity: Medium.
- Type: Best practice.
- Files: `services/worldService.js`, `services/politicsService.js`, `services/lifecycleService.js`.
- Evidence: Services store mutable module variables such as politics state, weather weight sums, news tick counters, and lifecycle tick counters.
- Risk: Harder isolated testing and reset between simulation runs.
- Acceptance criteria: Encapsulate service state behind initialization/reset methods or service instances. Add reset coverage for tests.

### REV-018: Worker social context and main social context can diverge

- Severity: Medium.
- Type: Correctness.
- Files: `workers/agent.worker.js`, `engine/matrix.js`, `services/socialService.js`.
- Evidence: Main thread builds `locationPeers`; worker builds local social context and processes social interactions within partition-local LOD1 agents.
- Risk: Cross-partition social interactions may be missed or context may differ from dashboard/state expectations.
- Acceptance criteria: Document partition social boundaries and add tests/metrics for agents at same location after rebalancing.

## Data, UI, Root Tooling

### REV-019: `config.env` is not loaded

- Severity: High.
- Type: Correctness/tooling.
- Files: `config.env`, `package.json`, `index.js`, `data/config.js`.
- Evidence: `dotenv` is a dependency and `config.env` exists, but no source imports `dotenv/config` or calls `dotenv.config()`.
- Risk: Operators think config is active while runtime uses defaults or shell environment only.
- Acceptance criteria: Decide whether to support `.env`/`config.env`. If yes, load it explicitly and document precedence. If no, remove the dependency/file and document shell env usage.

### REV-020: Numeric config parsing can produce `NaN`

- Severity: Medium.
- Type: Robustness.
- Files: `data/config.js`, `dbService.js`.
- Evidence: `parseInt(getEnv(...))` and `parseFloat(getEnv(...))` are used without finite-value fallback.
- Risk: Bad environment values can corrupt tick rate, population, diagnostics, or cache size.
- Acceptance criteria: Add parse helpers with finite checks and bounds. Add tests for valid, missing, and malformed env values.

### REV-021: Runtime data has weak schema validation

- Severity: High.
- Type: Robustness.
- Files: `data/dataLoader.js`, `data/*.yaml`, `data/worldGraph.js`.
- Evidence: YAML syntax/missing file checks exist, but most schema shapes are trusted. Activity location-type mismatch is warn-only.
- Risk: Parseable but malformed YAML can fail later during simulation, often far from startup.
- Acceptance criteria: Add schema validation for activities, graph nodes/edges, jobs, politics, events, and economics. Decide which warnings should become startup failures.

### REV-022: Dead runtime data and disconnected Postgres stack create architecture drift

- Severity: Medium.
- Type: Simplification.
- Files: `data/world_data.yaml`, `data/sensory.yaml`, `scripts/genesis.js`, `docker-compose.yml`, `db/schema.sql`, `package.json`.
- Evidence: Runtime uses SQLite and `dataLoader.js`; Postgres/Redis files exist but are not wired to `npm start`. `scripts/genesis.js` imports `pg`, which is not declared in `package.json`.
- Risk: Maintainers cannot tell whether these files are current, future, or abandoned.
- Acceptance criteria: Choose one: integrate into documented future architecture, move to `experiments/`, or remove. If retained, add scripts/dependencies/docs.

### REV-023: Dashboard inventory lookup uses the wrong catalog access path

- Severity: Medium.
- Type: Correctness.
- Files: `ui/dashboard.js`, `data/dataLoader.js`.
- Evidence: Dashboard checks `dataLoader.ITEM_CATALOG`, but `ITEM_CATALOG` is exported as a named binding, not as a property on the `dataLoader` instance.
- Risk: Inventory display falls back to raw item IDs instead of item names.
- Acceptance criteria: Import `ITEM_CATALOG` directly or attach catalog to the loader intentionally. Add a UI formatting test if practical.

### REV-024: Dashboard remains a large mixed-responsibility file

- Severity: High.
- Type: Simplification.
- Files: `ui/dashboard.js`.
- Evidence: Dashboard handles layout, rendering, formatting, console interception, keybindings, observer mode, profiler/log toggling, memory fetching, list signatures, and shutdown.
- Risk: UI fixes risk regressions in observer-mode invariants.
- Acceptance criteria: Extract pure formatting helpers and panel renderers first. Preserve observer-mode invariants documented in `.cursorrules`.

### REV-025: Project lacks baseline engineering tooling

- Severity: High.
- Type: Best practice.
- Files: `package.json`, project root.
- Evidence: No project README, tests, lint config, format config, CI, `.nvmrc`, or `engines` field. Only script is `npm start`.
- Risk: Scaling refactors have no safety net.
- Acceptance criteria: Add minimal scripts for `start`, `start:headless`, `check`, `test`, and `lint`; choose Node version policy; add CI once git hosting exists. Prefer built-in `node:test` initially to avoid dependency churn.

### REV-026: Runtime artifacts are not ignored without new `.gitignore`

- Severity: Medium.
- Type: Git hygiene.
- Files: `.gitignore`, runtime root files.
- Evidence: The workspace initially had no `.gitignore` and includes `node_modules`, logs, and potential DB artifacts.
- Risk: Baseline commits can accidentally include generated/runtime state.
- Acceptance criteria: Keep `.gitignore` covering `node_modules/`, logs, SQLite sidecars, and local env files before committing.

## Security And Dependency Notes

### REV-027: Dependency security review has not been automated

- Severity: Medium.
- Type: Security/tooling.
- Files: `package.json`, `package-lock.json`.
- Evidence: No `npm audit` script or CI. Dependencies include native `better-sqlite3` and older TUI packages (`blessed`, `blessed-contrib`).
- Risk: Known vulnerable transitive packages may go unnoticed.
- Acceptance criteria: Add an audit/check process appropriate for a local simulation project. Document accepted risks for unmaintained TUI packages.

### REV-028: Docker default credentials are development-only but undocumented

- Severity: Low.
- Type: Security/documentation.
- Files: `docker-compose.yml`.
- Evidence: Defaults include `POSTGRES_PASSWORD=changeme` and `PGADMIN_DEFAULT_PASSWORD=admin`.
- Risk: Unsafe if reused outside local development.
- Acceptance criteria: Document docker stack as local-only or require explicit env values before use.

### REV-029: Hard process exits reduce embeddability and testability

- Severity: Medium.
- Type: Robustness.
- Files: `index.js`, `engine/matrix.js`, `data/worldGraph.js`, `workers/agent.worker.js`.
- Evidence: Fatal paths call `process.exit()` from several modules.
- Risk: Tests and future embedding cannot recover from errors cleanly.
- Acceptance criteria: Reserve `process.exit()` for `index.js` or worker shutdown boundaries; throw typed errors elsewhere.

### REV-030: No behavioral smoke baseline exists yet

- Severity: Medium.
- Type: Testing.
- Files: project root, `package.json`.
- Evidence: No test script or committed smoke-run baseline.
- Risk: Future simplification lacks a simple "it boots and advances ticks" safety check.
- Acceptance criteria: Add a short headless smoke test that boots with a small population, advances a bounded number of ticks, and exits cleanly without requiring the TUI.
