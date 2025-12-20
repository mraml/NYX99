NYC 1999 Matrix Simulator - Massive Scale Scaffold (v4.0)

Project Overview

A life simulation engine set in New York City, 1999, designed to scale from a few dozen to 8,000,000+ simultaneous agents. Features emotionally-driven autonomous agents with needs, relationships, and jobs, all operating in a persistent, queryable, and distributed world.

Core Tech (v4.0): Node.js (Distributed Workers), Geospatial Sharding, Redis Cluster (Distributed Cache), Sharded PostgreSQL, RabbitMQ/Kafka (Message Queue), Prometheus/Grafana (Observability), LLM (Async Workers)

Scale: 30...8,000,000+ simultaneous agents

New in v4.0: This plan supersedes v3.1, replacing its single-process design with a horizontally-scalable, distributed architecture. The core principle is Geospatial Sharding (Zoning).

Architecture Overview (v4.0 - Distributed)

v4.0 update: The system is now a collection of microservices. The simulation is broken into Zones (geospatial shards), each managed by a ZoneProcessor. All state is held in a distributed cache (Redis) and services communicate via a central message queue (RabbitMQ).

   ┌────────────────────────────────┐
   │ Web Dashboard (Grafana)        │ ◄──┐
   │  - Metrics, Logs, Traces       │    │
   └────────────────────────────────┘    │
                   ▲                     │ (Consumes)
                   │ (Pushes Metrics)    │
┌─────────────────────────────────────┐ ┌──────────────────┐
│  Observability Stack (Prometheus)   │ │  LoggingService  │
└─────────────────────────────────────┘ └──────────────────┘
                   ▲                     ▲
                   │ (Pushes Metrics)    │ (Consumes Logs)
                   │                     │
┌──────────────────┴─────────────────────┴──────────────────┐
│             Message Queue (RabbitMQ / Kafka)              │
│ (Agent Handoffs, LLM Requests, Metrics, Logs, World Events) │
└──────────────────┬───────────────────┬───────────────────┘
     ▲ (pub/sub)   │ (pub/sub)         │ (pub/sub)
     │             │                   │
┌────┴─────┐ ┌─────▼───────────┐ ┌─────▼───────────┐
│Simulation│ │ ZoneProcessor A │ │ LLMConsumer (Pool)│
│Coordinator│ │ (Worker Fleet)  │ │ (Async Workers)   │
└──────────┘ └─────────────────┘ └───────────────────┘
     │             │                   │
 (Manages)     (Runs Sim Tick)     (Processes LLM)
     │             │                   │
     └──────┬──────┴────────┬──────────┘
            │                │
            ▼                ▼
┌──────────────────┐  ┌──────────────────┐
│ Distributed Cache│  │ Sharded Database │
│ (Redis Cluster)  │  │ (PostgreSQL x N) │
│ (Holds all hot   │  │ (Persistent State,│
│   agent state)   │  │  WAL, Checkpoints)│
└──────────────────┘  └──────────────────┘


Key Architectural Challenges (Massive Scale)

1. Challenge: Single-Process Bottleneck

Problem: The v3.1 matrix.js (a single Node.js process) cannot run the simulation tick for millions of agents.
Solution (v4.0): SimulationCoordinator + ZoneProcessors.

SimulationCoordinator (coordinator.js): A single service that manages global state (weather, time), balances load, and assigns simulation "Zones" (e.g., city blocks) to a fleet of ZoneProcessors.

ZoneProcessor (zoneProcessor.js): A pool of stateless worker services. Each ZoneProcessor is assigned one or more Zones. It loads only the agents in its assigned Zones from the cache, runs the tick logic for them, and writes the dirty state back. This is horizontally scalable—to add capacity, you just add more ZoneProcessor instances.

2. Challenge: In-Memory Cache Limit

Problem: The v3.1 CacheManager (in-process memory) cannot hold the state for millions of agents (this would require terabytes of RAM).
Solution (v4.0): Distributed Cache (Redis Cluster).

All "hot" agent state (needs, FSM, location, emotions) is stored in a Redis cluster, keyed by simulant_id.

ZoneProcessors fetch the agents for their zone from Redis at the start of their tick, compute the new state, and write it back.

This provides a shared, high-speed state layer that all ZoneProcessors can access.

3. Challenge: "Update All" Inefficiency

Problem: Ticking 8 million agents every 100ms is computationally wasteful and impossible. 99.9% of agents are not in an "active" area.
Solution (v4.0): Level of Detail (LOD) + Agent Handoffs.

LOD: Agents are ticked at different frequencies.

LOD 1 (Active): Agents in a "high-activity" zone (e.g., Times Square, or a zone with many agent interactions) are ticked every 100ms by a ZoneProcessor.

LOD 2 (Abstracted): Agents in a "low-activity" zone (e.g., an empty residential street at 3 AM) are ticked every 10 seconds.

LOD 3 (Summarized): Agents in zones with no activity are not ticked at all. Their state is simply updated by a periodic "summarization" job (e.g., "commute to work" is a single state change, not 1,000 ticks of walking).

Agent Handoffs: When an agent walks from Zone A to Zone B, the ZoneProcessor for Zone A publishes an agent_handoff message to the Message Queue. The SimulationCoordinator routes this message to the ZoneProcessor for Zone B, which then "claims" the agent and loads it into its next tick.

4. Challenge: Database I/O Limit

Problem: A single PostgreSQL instance (v3.1) cannot handle the write load (WALs, checkpoints, metrics) or read load for millions of agents.
Solution (v4.0): Sharded Database Layer.

The PostgreSQL database is sharded (e.g., by simulant_id or zone_id).

The DatabaseService is now a ShardedDbService that understands the sharding key. When it syncs dirty entities, it routes the writes to the correct database shard.

WALs and Checkpoints are now also sharded. A "checkpoint" is no longer a single blob but a snapshot of a single zone, stored on its corresponding DB shard. This makes recovery parallel.

5. Challenge: Synchronous/Coupled Systems

Problem: The v3.1 EventBus is in-process, meaning all services must run on the same machine. This prevents distribution.
Solution (v4.0): Message Queue (RabbitMQ/Kafka).

All inter-service communication happens asynchronously via a message queue.

Examples: agent_handoff, llm_request, llm_response, world_event, log_message, metrics_batch.

This decouples all services. A ZoneProcessor can request an LLM action by firing a message and continuing its tick. It doesn't block and wait.

6. Challenge: LLM Service Bottleneck

Problem: The v3.1 LLMService (single-point-of-call) cannot service thousands of requests per second.
Solution (v4.0): Asynchronous LLM Consumers.

When a ZoneProcessor determines an agent needs an "Oracle" call, it publishes a llm_request message to the queue.

A separate fleet of LLMConsumers (workers) subscribes to this queue. They pick up messages, make the external API call, and publish an llm_response message back.

The agent's FSM is now asynchronous (e.g., state: AWAITING_LLM_RESPONSE). When the response arrives, the ZoneProcessor for that agent's zone picks it up and advances the agent's state.

7. Challenge: Social Graph Complexity

Problem: A graph of 8 million nodes (v3.1 Neo4j) is a massive, dedicated system, not an "optional" component.
Solution (v4.0): Social Graph Approximation / Dedicated Cluster.

Approach A (Approximation): Agents only query for relationships in their immediate vicinity (Postgres-based query for "agents in my zone") or their pre-defined contacts (family, co-workers). We abandon the idea of a fully queryable 8M-node graph.

Approach B (Dedicated Cluster): If a full graph is required, Neo4j (or similar) is implemented as its own sharded, high-availability cluster. This is a massive engineering task in itself. This plan assumes Approach A for feasibility.

8. Challenge: Observability

Problem: The v3.1 blessed-contrib terminal dashboard cannot visualize a distributed system.
Solution (v4.0): Professional Observability Stack.

Metrics: All services (Coordinator, ZoneProcessors, etc.) expose metrics (e.g., tick duration per zone, queue depth) to Prometheus.

Dashboard: Grafana is used to build web dashboards from Prometheus data.

Logging: All services write logs to stdout, which are collected by a LoggingService (like Loki or an ELK stack) for centralized, queryable logging.

Enhanced Database Schema (Sharded)

The tables from v3.1 remain relevant, but they are now distributed across multiple database shards.

Sharding Strategy:

Shard Key: simulant_id (or zone_id if agents are static).

simulant_state, memories, memories_archive are sharded by simulant_id.

wal_log and checkpoint_state are sharded. checkpoint_state now stores snapshots per zone, not for the whole world.

pending_operations (Saga) remains critical for any cross-shard or cross-DB operations.

Modified System Components (v4.0)

coordinator.js (NEW - Replaces matrix.js)

Responsibilities: Manages the list of ZoneProcessors. Assigns and rebalances zones based on load. Ticks global state (weather, economy). Manages agent handoffs by routing messages.

zoneProcessor.js (NEW)

Responsibilities: A stateless worker.

Receives zone assignment (e.g., Zone-123) from Coordinator.

Fetches all agents for Zone-123 from Distributed Cache (Redis).

Runs the core FSM/needs/scheduler logic for those agents.

Publishes any cross-zone handoffs, LLM requests, or events to Message Queue.

Writes all "dirty" agent states back to Redis.

Periodically flushes dirty state from Redis to the correct Sharded Database shard.

Pushes metrics (tick time, agent count) to Prometheus.

shardedDbService.js (Evolves dbService.js)

Responsibilities: An abstraction layer that understands the database sharding.

getSimulant(id): Hashes id to find the correct DB shard.

syncDirtyEntities(entities): Groups entities by shard and writes in parallel.

Manages sharded WALs and sharded (per-zone) checkpoints.

cacheService.js (Evolves cacheManager.js)

Responsibilities: A wrapper for the Redis Cluster client.

getAgentsForZone(zoneId)

setAgentState(agent)

Handles all cache-level validation, dirty tracking (in Redis), and metrics.

messageQueue.js (NEW - Replaces eventBus.js)

Responsibilities: A wrapper for RabbitMQ or Kafka client.

Provides simple publish(topic, message) and subscribe(topic, callback) methods.

Manages all topic/queue definitions (e.g., agent.handoff, llm.request, metrics.log).

llmConsumer.js (NEW - Evolves llmService.js)

Responsibilities: A stateless worker that subscribes to the llm.request queue.

Implements the circuit breaker, timeout, and retry logic from v3.1.

On completion, publishes a llm_response message.

WebDashboard (Replaces dashboard.js)

This is no longer a .js file in the project, but a Grafana instance configured to read from Prometheus.

Configuration Structure (config.js)

Redis Cluster: host, port, etc.

Message Queue: uri, queues, topics.

Database Shards: An array of shard connection strings.

Coordinator Config: load_balancing_interval.

ZoneProcessor Config: lod_thresholds.

LLM Config: (Same as v3.1)

Observability: prometheus_endpoint, logging_endpoint.

Startup Flow (v4.0)

SysAdmin: Starts external services: Sharded PostgreSQL, Redis Cluster, RabbitMQ, Prometheus/Grafana.

Start Coordinator: node coordinator.js. It connects to all services and waits for workers.

Start Consumers: node llmConsumer.js (as a scalable fleet, e.g., in Kubernetes).

Start Processors: node zoneProcessor.js (as a scalable fleet).

Startup Flow:

ZoneProcessors register with the Coordinator.

Coordinator loads the world's zone map.

Coordinator recovers state by loading the latest per-zone checkpoints from the sharded DB into Redis.

Coordinator assigns zones to available ZoneProcessors.

ZoneProcessors begin fetching their assigned agents from Redis and start the tick loop.

Coordinator begins the global tick loop (weather, etc.).

Game Loop Flow (v4.0 - Distributed)

Coordinator Loop (e.g., every 1 second):

Update global state (weather, time).

Publish world_tick message.

Check ZoneProcessor heartbeats.

Analyze metrics from Prometheus to rebalance zones (e.g., Zone-123 is too "hot," so split it and assign to a new worker).

ZoneProcessor Loop (e.g., every 100ms - LOD 1):

Fetch all agents for its assigned active zones from Redis.

Receive any incoming messages (e.g., agent_handoff from another zone, llm_response).

Update all agents (needs, FSM, activities).

Agent moves?

If still in zone: Update location in Redis.

If crosses boundary: Publish agent_handoff message. The agent is no longer this processor's problem.

LLM needed?

Publish llm_request message. Set agent state to AWAITING_LLM.

Write all dirty agent states back to Redis.

Publish metrics to Prometheus.

Periodic Sync (Handled by ZoneProcessor, e.g., every 5 seconds):

Get all dirty entities in its zones from Redis.

Flush them to the correct ShardedDbService shard (non-blocking).

Flush any critical WAL operations.

Implementation Priority (v4.0)

Priority 1 (Core Infrastructure)

Set up and configure Redis Cluster, Sharded PostgreSQL, and RabbitMQ.

Create cacheService.js and messageQueue.js wrappers.

Define the ShardedDbService and sharding strategy.

Define the world "Zone" map.

Priority 2 (Core Loop)

Build the SimulationCoordinator (zone assignment, load balancing stub).

Build the ZoneProcessor (fetches from cache, runs sim logic, writes to cache).

Implement the agent_handoff logic between two ZoneProcessors via the message queue.

Priority 3 (Sim Features)

Integrate the v3.1 scheduler.js, needs, and FSM logic inside the ZoneProcessor's tick loop.

Implement the LOD (Level of Detail) logic (active/abstracted ticks).

Implement the DB persistence (sharded WAL/checkpoints) from ZoneProcessors.

Priority 4 (Async Services)

Build the llmConsumer.js worker.

Integrate the llm_request/llm_response async flow into the agent FSM.

Implement the Social Graph Approximation (local-only queries).

Priority 5 (Observability & Resilience)

Set up Prometheus and Grafana.

Instrument all services (Coordinator, Processors) to push metrics.

Implement the Test/Chaos plan from v3.1, but in a distributed context (kill random ZoneProcessor nodes, simulate queue/DB/cache failures).