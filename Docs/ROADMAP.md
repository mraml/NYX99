NYC 1999 Simulation: Enhancement Roadmap

We have successfully refactored the simulation's core, implementing a high-performance event bus (completing Item #2) and a robust, config-driven data pipeline (completing Item #10). The "Idle" state is now correctly understood as an agent's "content" FSM state, with granular activities providing immersion.

The following plan outlines the next steps to evolve the simulation, prioritized by what will provide the biggest "wow" factor in terms of immersion and realism.

Phase 1: The "Living World" Foundations (Impact: High)

Goal: Make the world itself feel less static and mechanical. This phase breaks the "instant teleport" illusion and makes agent movement and location choice more realistic and performant.

1. Decouple Agent Movement from the Grid (User Item #4)

Problem: Motion appears unnatural or “jumping tile-to-tile”.

Solution: Introduce movement interpolation and path prediction.

location_graph.yaml: Add a travel_ticks property to each edge.

fsm.js: When an agent commutes, set agent.state to IN_TRANSIT and set a agent.travelTimer = edge.travel_ticks. The agent's locationId will be null.

agent.js: While IN_TRANSIT, updateLOD1 simply ticks down the timer. When it hits 0, the agent arrives at the destination (agent.locationId = agent.transitTo).

Impact: Adds fluidity and realism; improves frame-rate-to-simulation-tick decoupling, as a future UI can interpolate an agent's position between transitFrom and transitTo.

2. Implement Location Capacity & Collision Avoidance (User Item #4)

Problem: A single coffee_shop node can hold all 1000 agents simultaneously.

Solution:

world_data.yaml: Add a capacity property to location nodes.

matrix.js: Create a fast, cached helper function getAgentCountAtLocation(locationId).

fsm.js: In getAgentGoal(), agents must check if a location is full (matrix.getAgentCountAtLocation('locA') < locA.capacity) before choosing it as a target, forcing them to find alternatives.

Impact: This is the logical foundation for collision avoidance and prevents unrealistic "dogpiling."

3. Implement World Physics & Environmental Signals (User Item #3)

Problem: The world appears static — limited physics, no resource cycles, no sensory gradients.

Solution:

worldGraph.js: Nodes will gain properties for light, noise, and temperature, which are updated by matrix.js based on time of day.

fsm.js: An agent's FSM will be affected by these signals (e.g., they won't choose to WANDER to a park at 3 AM when light is 0 and temperature is low).

world_data.yaml: Introduce simple depletable/renewable resources (e.g., a coffee shop has a "resource" of coffee that depletes and is restocked).

Impact: Supports more realistic stealth, survival, and dynamic agent decisions based on the environment.

4. Create a Pathfinding Cache (Performance)

Problem: worldGraph.findPath() (a BFS) is called repeatedly for the same paths, which will become a major performance bottleneck.

Solution:

worldGraph.js: Create a this.pathCache = {}.

In findPath(startKey, endKey), check the cache first. If a path is not found, calculate it, then store it in the cache before returning it.

Impact: Dramatically speeds up agent decision-making.

5. Implement Statistical LOD2 (Performance & Realism)

Problem: LOD2 (background) agents teleport randomly and fulfill needs instantly, which breaks realism when they enter LOD1.

Solution:

agent.js: Rework updateLOD2(). Instead of teleporting, perform a "statistical" update.

Example: If 8 hours (240 ticks) of work time passed, don't move the agent. Just calculate: money += (pay_per_hour * 8), energy += (decay_per_hour * 8), etc. This simulates their day in place without pathfinding.

Impact: Their needs will be accurate and realistic when they re-enter LOD1.

Phase 2: The "Sentient Agent" Update (Impact: Highest)

Goal: Transform agents from robotic entities into believable people who have relationships, memories, emotional states, and emergent social goals.

1. Implement Persistent Internal State & Memory (User Item #1)

Problem: Agents react only to immediate conditions, making behaviors feel robotic and predictable.

Solution: Introduce short-term/long-term memory with decay, emotional state, personality traits, and social relationships.

dbService.js: Expand the relationships table to include relationship_type: 'family', 'friend', 'romantic', 'coworker', 'stranger'.

agent.js: Add this.mood = { valence: 0 } and this.shortTermMemory = [].

matrix.js / fsm.js: Queue agent:hadExperience events for significant moments (good social chat, a fight, a failed goal).

agent.js: Create an updateMood() method to process these memories, apply them to this.mood.valence, and then "decay" the mood back toward 0.

fsm.js: getAgentGoal() will now be influenced by mood (e.g., a sad agent avoids socializing).

Impact: Dramatically increases emergent behavior realism and user immersion; makes debugging AI behavior easier due to traceable motivation.

2. Implement FSM "Wants" vs. "Needs" (Plans)

Problem: The FSM is purely reactive to needs. It never wants to do anything.

Solution:

agent.js: Add a new property: this.plans = []. A plan is an object like { tick: 10500, type: 'MEET_AGENT', targetAgentId: 'uuid-agent-B', locationId: 'loc-bar' }.

fsm.js: In getAgentGoal(), add a Priority 0 check: "Do I have a plan for this tick?" If yes, that plan becomes their goal, overriding all basic needs.

matrix.js: The socialization loop will be upgraded. When two friends interact, they will have a chance to create a new plan and add it to each other's this.plans list.

Phase 3: The "Architect" UX & Emergence (Impact: Medium-High)

Goal: Empower the user (The Architect) with the tools to observe, control, and understand the emergent stories created in Phase 2.

1. Enhance Simulation Observability (User Item #7)

Problem: Hard to track world state changes and agent decisions.

Solution: Add diagnostic channels: metrics, AI-decision logs, and visual overlays.

dashboard.js: Create a new "View 5 (Profiler)" that calls eventBus.getEventProfile() and renders a table of event names and their counts.

dashboard.js: Create a new "View 6 (History)" that calls eventBus.getEventHistory() and shows the last 100 events, enabling "time-travel" debugging.

Impact: Increased transparency enhances UX, enables optimization, and provides better storytelling.

2. Implement Simulation Time Controls (User Item #5)

Problem: Fixed tick pacing creates CPU spikes and limits UX (pause/rewind/speed-up).

Solution: Adopt variable-rate scheduling.

matrix.js: Change runTick() from setTimeout to a setInterval stored as this.tickInterval.

dashboard.js: Add keybinds for P (Pause/Play), > (Fast-Forward), and + (Normal Speed) that clearInterval and set a new one with a modified TICK_RATE_MS.

Impact: Smooth performance and allows fast-forwarding for debugging and observation.

3. Implement "Follow Cam" and Agent Selection

Problem: We can only "focus" on a location. We can't follow a specific agent.

Solution:

dashboard.js: Make the agent list (View 0) selectable (e.g., with 'Enter').

On selection, dashboard.js queues a ui:followAgent event with the agent's ID.

matrix.js: Listens for this event and sets this.followedAgentId. The tick() loop is updated to always set this.playerFocus = this.followedAgent.locationId, making the map follow them.

4. Implement Shallow User Interaction Model (User Item #9)

Problem: User influence over the simulation is limited, reducing engagement.

Solution: Add indirect influence mechanics.

matrix.js: The Architect can trigger "World Events" (e.g., "Subway Strike," "Stock Market Crash," "Heat Wave").

fsm.js: These active events will change agent decision-making (e.g., a "Subway Strike" increases travel_ticks; a "Stock Market Crash" makes agents prioritize WORK more).

Impact: Increases player agency while preserving emergent complexity.

Phase 4: Long-Term Stability & Scale (Impact: High)

Goal: Ensure the simulation can run for days or weeks (real-time) without crashing or slowing down, enabling true massive-scale populations.

1. Implement Resource Allocation & Garbage Accumulation (User Item #8)

Problem: Objects, agents, and events accumulate without lifecycle control, degrading performance over time.

Solution: Introduce pooling, aging, despawn rules, and memory cleanup.

Agent Lifecycle: Add an age property to agent.js. Add a populationManager to matrix.js that periodically "despawns" old agents (queuing agent:despawn) and spawns new ones.

Data Cleanup: cacheManager.js and dbService.js will listen for agent:despawn and delete the agent and all their associated data (memories, relationships).

Memory/Plan Cleanup: The updateMood() and FSM methods in agent.js will be responsible for "forgetting" old memories and failed plans.

Impact: Creates a stable, long-running simulation and enables dynamic population growth and churn, which is highly realistic.

Phase 5: AI Architecture Refactor (Impact: Long-Term)

Goal: Evolve the AI from a simple FSM to a more robust, extensible, and powerful system.

1. Abstract Behavior Trees / GOAP AI (User Item #6)

Problem: The current FSM, while effective, will become a complex, monolithic "god-object" as we add more "Sentient Agent" features.

Solution: Externalize decision policies into a formal Behavior Tree or Goal-Oriented Action Planning (GOAP) system.

Impact: This is a major refactor that provides a cleaner, modular AI evolution. It enables pluggable behaviors and makes it far easier to add complex, multi-step agent plans (e.g., "Go to store, buy ingredients, go home, cook meal").

Files: This would involve creating a new AI directory and refactoring fsm.js and agent.js to use it.