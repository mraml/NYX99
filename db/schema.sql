-- =============================================================================
-- NYC SIMULATION - DATABASE SCHEMA
-- =============================================================================
-- This script initializes the PostgreSQL database with PostGIS and TimescaleDB
-- extensions, creates all necessary tables, indexes, and helper functions.
--
-- Execution: Runs automatically when container starts via docker-entrypoint-initdb.d
-- =============================================================================

-- =============================================================================
-- EXTENSIONS
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

COMMENT ON EXTENSION postgis IS 'Spatial data types and functions';
COMMENT ON EXTENSION timescaledb IS 'Time-series database optimizations';
COMMENT ON EXTENSION pg_stat_statements IS 'Query performance tracking';

-- =============================================================================
-- LOCATIONS TABLE (Static World Geography)
-- =============================================================================
CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  borough TEXT NOT NULL,
  type TEXT NOT NULL,
  geom GEOMETRY(Point, 4326) NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 10,
  properties JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  CONSTRAINT capacity_positive CHECK (capacity > 0)
);

-- Indexes for locations
CREATE INDEX idx_locations_geom ON locations USING GIST(geom);
CREATE INDEX idx_locations_borough ON locations(borough);
CREATE INDEX idx_locations_type ON locations(type);
CREATE INDEX idx_locations_properties ON locations USING GIN(properties);

-- Composite index for common query pattern
CREATE INDEX idx_locations_borough_type ON locations(borough, type);

COMMENT ON TABLE locations IS 'Static world geography (buildings, streets, parks, etc.)';
COMMENT ON COLUMN locations.id IS 'Unique location identifier (e.g., manhattan_0)';
COMMENT ON COLUMN locations.name IS 'Human-readable name (e.g., "Joe''s Pizza")';
COMMENT ON COLUMN locations.geom IS 'Geographic point in WGS84 (EPSG:4326)';
COMMENT ON COLUMN locations.properties IS 'Flexible metadata: rent, operating_hours, is_business, etc.';

-- =============================================================================
-- CONNECTIONS TABLE (Static World Graph Edges)
-- =============================================================================
CREATE TABLE connections (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  target TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  geom GEOMETRY(LineString, 4326) NOT NULL,
  distance_meters FLOAT NOT NULL,
  travel_time_seconds INTEGER NOT NULL,
  properties JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  CONSTRAINT distance_positive CHECK (distance_meters > 0),
  CONSTRAINT travel_time_positive CHECK (travel_time_seconds > 0),
  UNIQUE(source, target)
);

-- Indexes for connections
CREATE INDEX idx_connections_geom ON connections USING GIST(geom);
CREATE INDEX idx_connections_source ON connections(source);
CREATE INDEX idx_connections_target ON connections(target);

-- Composite index for bidirectional lookups
CREATE INDEX idx_connections_source_target ON connections(source, target);

COMMENT ON TABLE connections IS 'Static world graph edges with real-world distances';
COMMENT ON COLUMN connections.distance_meters IS 'Haversine distance between source and target';
COMMENT ON COLUMN connections.travel_time_seconds IS 'Estimated travel time (walking speed: 1.4 m/s)';
COMMENT ON COLUMN connections.properties IS 'Edge metadata: terrain_type, accessibility, etc.';

-- =============================================================================
-- AGENTS TABLE (Dynamic Simulation State)
-- =============================================================================
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  geom GEOMETRY(Point, 4326) NOT NULL,
  current_location_id TEXT REFERENCES locations(id),
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_updated_tick BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  CONSTRAINT tick_non_negative CHECK (last_updated_tick >= 0)
);

-- Indexes for agents
CREATE INDEX idx_agents_geom ON agents USING GIST(geom);
CREATE INDEX idx_agents_location ON agents(current_location_id);
CREATE INDEX idx_agents_tick ON agents(last_updated_tick);
CREATE INDEX idx_agents_state ON agents USING GIN(state);

COMMENT ON TABLE agents IS 'Current agent state (updated every simulation tick)';
COMMENT ON COLUMN agents.geom IS 'Current geographic position';
COMMENT ON COLUMN agents.current_location_id IS 'Current location key (FK to locations)';
COMMENT ON COLUMN agents.state IS 'Agent state: needs, FSM status, inventory, etc.';
COMMENT ON COLUMN agents.last_updated_tick IS 'Last tick this agent was updated (prevents stale writes)';

-- =============================================================================
-- AGENT_HISTORY TABLE (Time-Series Movement Data)
-- =============================================================================
CREATE TABLE agent_history (
  agent_id TEXT NOT NULL,
  tick BIGINT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  geom GEOMETRY(Point, 4326),
  location_id TEXT,
  action TEXT,
  state_snapshot JSONB,
  
  CONSTRAINT tick_non_negative CHECK (tick >= 0)
);

-- Convert to TimescaleDB hypertable (partitioned by time)
SELECT create_hypertable(
  'agent_history', 
  'timestamp',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

-- Indexes for agent history
CREATE INDEX idx_agent_history_agent_time ON agent_history(agent_id, timestamp DESC);
CREATE INDEX idx_agent_history_geom ON agent_history USING GIST(geom);
CREATE INDEX idx_agent_history_location ON agent_history(location_id);
CREATE INDEX idx_agent_history_tick ON agent_history(tick);

-- Retention policy: Auto-delete data older than 30 days
SELECT add_retention_policy(
  'agent_history', 
  INTERVAL '30 days',
  if_not_exists => TRUE
);

COMMENT ON TABLE agent_history IS 'Historical agent movements (time-series, auto-partitioned by day)';
COMMENT ON COLUMN agent_history.action IS 'Significant actions: enter_location, exit_location, start_activity, etc.';
COMMENT ON COLUMN agent_history.state_snapshot IS 'Agent state at time of action (optional, for debugging)';

-- =============================================================================
-- CONTINUOUS AGGREGATES (TimescaleDB)
-- =============================================================================
-- Hourly agent activity summary (for analytics/dashboards)
CREATE MATERIALIZED VIEW agent_activity_hourly
WITH (timescaledb.continuous) AS
SELECT 
  agent_id,
  time_bucket('1 hour', timestamp) as hour,
  COUNT(*) as action_count,
  COUNT(DISTINCT location_id) as unique_locations_visited,
  ST_Centroid(ST_Collect(geom)) as avg_position
FROM agent_history
GROUP BY agent_id, hour
WITH NO DATA;

-- Refresh policy: Update aggregates every hour
SELECT add_continuous_aggregate_policy(
  'agent_activity_hourly',
  start_offset => INTERVAL '3 hours',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);

COMMENT ON MATERIALIZED VIEW agent_activity_hourly IS 'Pre-aggregated hourly agent activity for fast analytics';

-- =============================================================================
-- SIMULATION_STATE TABLE (Metadata & Checkpoints)
-- =============================================================================
CREATE TABLE simulation_state (
  id SERIAL PRIMARY KEY,
  current_tick BIGINT NOT NULL,
  world_time TIMESTAMPTZ NOT NULL,
  world_state JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  CONSTRAINT tick_non_negative CHECK (current_tick >= 0)
);

-- Only keep the most recent simulation state
CREATE UNIQUE INDEX idx_simulation_state_latest ON simulation_state((1));

COMMENT ON TABLE simulation_state IS 'Current simulation metadata and checkpoint info';
COMMENT ON COLUMN simulation_state.world_state IS 'Global state: weather, active events, time of day, etc.';

-- =============================================================================
-- MIGRATION_LOG TABLE (Track Migration Execution)
-- =============================================================================
CREATE TABLE migration_log (
  id SERIAL PRIMARY KEY,
  phase TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed', 'rolled_back')),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  metrics JSONB DEFAULT '{}'::jsonb,
  error_details TEXT
);

CREATE INDEX idx_migration_log_status ON migration_log(status);
CREATE INDEX idx_migration_log_started ON migration_log(started_at DESC);

COMMENT ON TABLE migration_log IS 'Audit trail for data migration execution';

-- =============================================================================
-- HELPER FUNCTIONS
-- =============================================================================

-- Function: Calculate real-world distance between two geometries (meters)
CREATE OR REPLACE FUNCTION calculate_distance_meters(
  geom1 GEOMETRY,
  geom2 GEOMETRY
) RETURNS FLOAT AS $$
BEGIN
  -- Cast to geography for accurate spherical distance calculation
  RETURN ST_Distance(geom1::geography, geom2::geography);
END;
$$ LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE;

COMMENT ON FUNCTION calculate_distance_meters IS 'Calculate distance in meters between two geometries';

-- Function: Get agents within radius (optimized spatial query)
CREATE OR REPLACE FUNCTION get_agents_in_radius(
  center_lat FLOAT,
  center_lon FLOAT,
  radius_meters FLOAT
) RETURNS TABLE(
  agent_id TEXT,
  distance_meters FLOAT,
  location JSONB,
  state JSONB
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    a.id,
    ST_Distance(
      a.geom::geography,
      ST_SetSRID(ST_MakePoint(center_lon, center_lat), 4326)::geography
    ) as distance,
    ST_AsGeoJSON(a.geom)::jsonb,
    a.state
  FROM agents a
  WHERE ST_DWithin(
    a.geom::geography,
    ST_SetSRID(ST_MakePoint(center_lon, center_lat), 4326)::geography,
    radius_meters
  )
  ORDER BY a.geom <-> ST_SetSRID(ST_MakePoint(center_lon, center_lat), 4326);
END;
$$ LANGUAGE plpgsql STABLE PARALLEL SAFE;

COMMENT ON FUNCTION get_agents_in_radius IS 'Get all agents within radius_meters of a point, ordered by distance';

-- Function: Get nearest location by type
CREATE OR REPLACE FUNCTION get_nearest_location(
  center_lat FLOAT,
  center_lon FLOAT,
  location_type TEXT,
  max_distance_meters FLOAT DEFAULT 5000
) RETURNS TABLE(
  location_id TEXT,
  location_name TEXT,
  distance_meters FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    l.id,
    l.name,
    ST_Distance(
      l.geom::geography,
      ST_SetSRID(ST_MakePoint(center_lon, center_lat), 4326)::geography
    ) as distance
  FROM locations l
  WHERE l.type = location_type
    AND ST_DWithin(
      l.geom::geography,
      ST_SetSRID(ST_MakePoint(center_lon, center_lat), 4326)::geography,
      max_distance_meters
    )
  ORDER BY l.geom <-> ST_SetSRID(ST_MakePoint(center_lon, center_lat), 4326)
  LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE PARALLEL SAFE;

COMMENT ON FUNCTION get_nearest_location IS 'Find nearest location of a specific type within max distance';

-- Function: Get location occupancy (agent count)
CREATE OR REPLACE FUNCTION get_location_occupancy(location_key TEXT)
RETURNS INTEGER AS $$
DECLARE
  agent_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO agent_count
  FROM agents
  WHERE current_location_id = location_key;
  
  RETURN agent_count;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION get_location_occupancy IS 'Count agents currently at a location';

-- =============================================================================
-- TRIGGERS
-- =============================================================================

-- Trigger: Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_locations_updated_at
  BEFORE UPDATE ON locations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_agents_updated_at
  BEFORE UPDATE ON agents
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_simulation_state_updated_at
  BEFORE UPDATE ON simulation_state
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- PERFORMANCE TUNING
-- =============================================================================

-- Update statistics for query planner
ANALYZE locations;
ANALYZE connections;
ANALYZE agents;
ANALYZE agent_history;

-- =============================================================================
-- INITIALIZATION COMPLETE
-- =============================================================================
DO $$
BEGIN
  RAISE NOTICE 'NYC Simulation database schema initialized successfully';
  RAISE NOTICE 'PostGIS version: %', postgis_version();
  RAISE NOTICE 'TimescaleDB version: %', (SELECT extversion FROM pg_extension WHERE extname = 'timescaledb');
END $$;