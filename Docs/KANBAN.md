# NYC 1999 Kanban

This board is seeded from `Docs/ReviewFindings.md`. Cards are intentionally backlog items only; this review did not change simulation behavior.

## Ready

Ready cards should be promoted from Backlog after the repository baseline is committed and implementation scope is selected.

## In Progress

No implementation cards are in progress.

## Backlog

### Milestone 0: Repository Baseline

#### REV-026: Keep runtime artifacts out of version control

- Severity: Medium.
- Type: Git hygiene.
- Files: `.gitignore`, runtime root files.
- Acceptance criteria: `node_modules/`, logs, SQLite DB files/sidecars, and local env files are ignored before commits.

### Milestone 1: Correctness Stabilization

#### REV-001: Unify worker and fallback agent update paths

- Severity: Critical.
- Type: Correctness.
- Files: `engine/matrix.js`, `engine/agent.js`, `services/agentService.js`, `engine/fsmStates/BaseState.js`.
- Acceptance criteria: Worker and fallback updates delegate to the same authoritative update path or have a tested equivalence contract.

#### REV-002: Consolidate biological decay semantics

- Severity: Critical.
- Type: Correctness.
- Files: `engine/agent.js`, `engine/fsmStates/BaseState.js`, `services/agentService.js`.
- Acceptance criteria: One stat-decay model exists; `social` semantics are documented; tests cover core needs and state overrides.

#### REV-003: Fix worker IPC merge coverage

- Severity: Critical.
- Type: Correctness.
- Files: `workers/agent.worker.js`, `engine/cacheManager.js`.
- Acceptance criteria: Every worker-serialized field is intentionally merged or intentionally excluded with a tested contract.

#### REV-011: Define `stateContext` ownership and lifecycle

- Severity: High.
- Type: Correctness.
- Files: `engine/fsm.js`, `engine/fsmStates/*.js`, `engine/cacheManager.js`, `workers/agent.worker.js`.
- Acceptance criteria: State context has an explicit lifecycle convention and tests for work, social, shopping, and commute context.

#### REV-016: Clarify transit ownership

- Severity: Medium.
- Type: Cleanup/correctness.
- Files: `services/agentService.js`, `engine/agent.js`, `engine/fsmStates/CommutingState.js`.
- Acceptance criteria: Transit lives in one API/state path; dead `inTransit/_handleMovement` references are removed or implemented.

#### REV-023: Fix dashboard inventory catalog lookup

- Severity: Medium.
- Type: Correctness.
- Files: `ui/dashboard.js`, `data/dataLoader.js`.
- Acceptance criteria: Dashboard displays catalog item names when definitions exist.

#### REV-030: Add bounded headless smoke baseline

- Severity: Medium.
- Type: Testing.
- Files: project root, `package.json`.
- Acceptance criteria: A small-population smoke test boots, advances bounded ticks, and exits cleanly.

### Milestone 2: Simplification Without Feature Loss

#### REV-004: Split `Matrix` responsibilities

- Severity: High.
- Type: Simplification.
- Files: `engine/matrix.js`.
- Acceptance criteria: Worker orchestration, persistence scheduling, and world-service tick orchestration can be reasoned about independently.

#### REV-006: Normalize FSM alias registry

- Severity: Medium.
- Type: Simplification.
- Files: `engine/fsm.js`.
- Acceptance criteria: Canonical states and aliases are separated; aliases normalize consistently and remain debug-friendly.

#### REV-007: Replace fragile job-title string matching

- Severity: Medium.
- Type: Simplification.
- Files: `engine/agentUtilities.js`, `engine/fsmStates/WorkingState.js`, `data/activities.yaml`.
- Acceptance criteria: Job-to-working-tag mapping is table/data driven and every emitted tag exists in `activities.yaml`.

#### REV-008: Remove or implement dead/stub engine code

- Severity: Medium.
- Type: Simplification.
- Files: `engine/agent.js`, `engine/fsm.js`, `engine/cacheManager.js`, `engine/structures/PriorityQueue.js`, `services/agentService.js`.
- Acceptance criteria: Dead stubs are removed, implemented, or explicitly linked to a future card.

#### REV-009: Decompose `IdleState`

- Severity: High.
- Type: Simplification.
- Files: `engine/fsmStates/IdleState.js`.
- Acceptance criteria: Decision order is preserved and tested while helpers/policies are extracted.

#### REV-010: Reduce repeated state boilerplate

- Severity: Medium.
- Type: Simplification.
- Files: `engine/fsmStates/*.js`, `engine/BehaviorTreeCore.js`.
- Acceptance criteria: Standard tree/tick execution is shared or documented where intentionally different.

#### REV-012: Route state flavor logs consistently

- Severity: Low.
- Type: Best practice.
- Files: `engine/fsmStates/*.js`, `ui/dashboard.js`, `logger.js`.
- Acceptance criteria: FSM flavor uses eventBus/logger instead of direct console as the primary path.

#### REV-013: Remove ignored housing-state decay override

- Severity: Low.
- Type: Cleanup.
- Files: `engine/fsmStates/AcquireHousingState.js`, `engine/fsmStates/BaseState.js`.
- Acceptance criteria: The unused override is removed or implemented.

#### REV-018: Document or fix partition-local social context

- Severity: Medium.
- Type: Correctness.
- Files: `workers/agent.worker.js`, `engine/matrix.js`, `services/socialService.js`.
- Acceptance criteria: Cross-partition social boundaries are documented and tested/metriced.

#### REV-022: Resolve disconnected Postgres/docker/data artifacts

- Severity: Medium.
- Type: Simplification.
- Files: `data/world_data.yaml`, `data/sensory.yaml`, `scripts/genesis.js`, `docker-compose.yml`, `db/schema.sql`, `package.json`.
- Acceptance criteria: Artifacts are integrated, moved to experiments/future docs, or removed.

#### REV-024: Decompose dashboard responsibilities

- Severity: High.
- Type: Simplification.
- Files: `ui/dashboard.js`.
- Acceptance criteria: Pure formatting/panel rendering helpers are extracted while observer-mode invariants are preserved.

### Milestone 3: Tooling, Tests, And Secure Code

#### REV-014: Move inline DB workers out of `eval`

- Severity: High.
- Type: Security.
- Files: `dbService.js`.
- Acceptance criteria: Backup/recovery worker code lives in static worker files and accepts validated worker data.

#### REV-015: Validate persisted JSON before hydration

- Severity: High.
- Type: Security/robustness.
- Files: `dbService.js`, `engine/cacheManager.js`, `engine/agent.js`, `engine/agentUtilities.js`.
- Acceptance criteria: Agent/checkpoint/WAL payloads are validated and corrupt records are reported or quarantined.

#### REV-017: Encapsulate module-level service state

- Severity: Medium.
- Type: Best practice.
- Files: `services/worldService.js`, `services/politicsService.js`, `services/lifecycleService.js`.
- Acceptance criteria: Services expose reset/instance patterns suitable for tests.

#### REV-019: Decide and implement config-file behavior

- Severity: High.
- Type: Correctness/tooling.
- Files: `config.env`, `package.json`, `index.js`, `data/config.js`.
- Acceptance criteria: `config.env` is either loaded and documented or removed in favor of shell env variables.

#### REV-020: Harden numeric config parsing

- Severity: Medium.
- Type: Robustness.
- Files: `data/config.js`, `dbService.js`.
- Acceptance criteria: Parse helpers handle missing/malformed values and enforce bounds.

#### REV-021: Add runtime YAML schema validation

- Severity: High.
- Type: Robustness.
- Files: `data/dataLoader.js`, `data/*.yaml`, `data/worldGraph.js`.
- Acceptance criteria: Activities, graph, jobs, politics, events, and economics fail fast or warn by policy.

#### REV-025: Add baseline engineering tooling

- Severity: High.
- Type: Best practice.
- Files: `package.json`, project root.
- Acceptance criteria: Scripts for check/test/lint/headless exist; Node version policy exists; CI plan is documented.

#### REV-027: Automate dependency security review

- Severity: Medium.
- Type: Security/tooling.
- Files: `package.json`, `package-lock.json`.
- Acceptance criteria: Audit process exists and accepted TUI/native dependency risks are documented.

#### REV-028: Document docker credentials as local-only

- Severity: Low.
- Type: Security/documentation.
- Files: `docker-compose.yml`.
- Acceptance criteria: Default credentials are clearly marked development-only or replaced by required env values.

#### REV-029: Reduce hard process exits outside process boundary

- Severity: Medium.
- Type: Robustness.
- Files: `index.js`, `engine/matrix.js`, `data/worldGraph.js`, `workers/agent.worker.js`.
- Acceptance criteria: Non-entry modules throw typed errors or signal failure instead of exiting the process directly.

### Milestone 4: Scale-Ready Features

These are future cards carried forward from the old roadmap. They should stay behind the correctness/simplification/tooling milestones.

#### FUT-001: Movement interpolation and travel durations

- Source: old roadmap Phase 1.
- Acceptance criteria: Travel has explicit duration data and UI-ready interpolation state.

#### FUT-002: Location capacity and crowding limits

- Source: old roadmap Phase 1.
- Acceptance criteria: Agents avoid full locations and fallback choices remain realistic.

#### FUT-003: Pathfinding cache with invalidation

- Source: old roadmap Phase 1.
- Acceptance criteria: Repeated route lookups are cached and invalidated when dynamic world events alter paths.

#### FUT-004: Statistical LOD2 behavior

- Source: old roadmap Phase 1.
- Acceptance criteria: Background agents update needs/economy plausibly without expensive pathfinding.

#### FUT-005: Persistent memory and emotional planning

- Source: old roadmap Phase 2.
- Acceptance criteria: Memories, moods, and relationships affect future decisions and decay/cleanup safely.

#### FUT-006: Multi-step goal stack/planner

- Source: old roadmap Phase 2 / long-term AI architecture.
- Acceptance criteria: Needs generate plans such as commute, shop, return home, eat.

#### FUT-007: Expanded inventory and item system

- Source: old implementation status Tier 3.
- Acceptance criteria: Inventory extends beyond current hardcoded catalog and remains data-driven.

#### FUT-008: Dynamic world events and user influence

- Source: old roadmap Phase 3.
- Acceptance criteria: World events can alter affordances, travel, and agent decisions through documented mechanisms.

## Done

### DOC-001: Current-state architecture capture

- Completed in `Docs/ARCHITECTURE.md`.

### DOC-002: Feature inventory/no-regression checklist

- Completed in `Docs/FEATURES.md`.

### DOC-003: Review findings

- Completed in `Docs/ReviewFindings.md`.

### DOC-004: Consolidated project plan

- Completed in `Docs/ProjectPlan.md`.

## Changelog

Preserved from the prior `Docs/kanban.yaml` session log:

- 2026-04-01, Daily Routine Loop Fix + Realism:
  - Stabilized `resolveDestinationForGoal` for `fsm_working` by persisting `workLocationId`.
  - Added `transitionWithCommuteIfNeeded` destination override for go-home.
  - Added `WorkingState` work-session completion tracking and lunch-break branch.
  - Added `WorkingState` commute when `locationId !== workLocationId`.
  - Reset `workSessionDone`/`lunchBreakTaken` off-shift in `IdleState`.
  - Added `IdleState` go-home behavior after maintenance.
  - Added lunch-break thresholds to balance constants.
- 2026-04-01, Morning prep + routine diagnostics:
  - Added day-shift pre-work prep gate at home before work dispatch.
  - Aligned `NeedsMorningRoutine` window to 4-10.
  - Added routine diagnostics config.
  - Added Matrix routine diagnostics for working counts, top states, and work-start histogram.
