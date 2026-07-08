import pg from 'pg';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const { Pool } = pg;

// --- CONFIGURATION ---
const GRID_SIZE_X = 100; // 100 blocks wide
const GRID_SIZE_Y = 100; // 100 blocks tall
const BLOCK_SIZE = 4;    // Roads appear every N tiles (Manhattan Grid)

const DB_CONFIG = {
  user: 'sim_admin',
  password: 'sim_password',
  host: 'localhost',
  port: 5432,
  database: 'nyc_world',
};

// --- DATA LOADERS ---
// We load your existing YAMLs to give the procedural world flavor
const loadYaml = (filename) => {
  try {
    const filePath = path.join(process.cwd(), 'data', filename);
    if (fs.existsSync(filePath)) {
      return yaml.load(fs.readFileSync(filePath, 'utf8'));
    }
    console.warn(`⚠️  Warning: ${filename} not found in /data. Using defaults.`);
    return null;
  } catch (e) {
    console.error(`Error loading ${filename}:`, e.message);
    return null;
  }
};

const worldData = loadYaml('world_data.yaml') || { consistent_locations: {} };
const locationsData = loadYaml('locations.yaml') || { consistent_locations: {} };

// Merge location names from all sources
const LOCATION_NAMES = {
  bar: [...(worldData.consistent_locations?.bar || []), ...(locationsData.consistent_locations?.bar || [])],
  restaurant: [...(worldData.consistent_locations?.restaurant || []), ...(locationsData.consistent_locations?.restaurant || [])],
  park: [...(worldData.consistent_locations?.park || []), ...(locationsData.consistent_locations?.park || [])],
  store: [...(worldData.consistent_locations?.store || []), ...(locationsData.consistent_locations?.store || [])],
  office: ['Global Corp', 'Tech StartUp', 'Law Firm', 'Consulting Agency', 'City Admin'],
  home: ['Apartment Complex', 'Brownstone', 'Loft', 'Tenement']
};

// --- GENERATOR LOGIC ---

const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

function generateTile(x, y) {
  // 1. Create Roads (Manhattan Grid Pattern)
  // Every BLOCK_SIZE tiles is a road.
  const isAve = x % BLOCK_SIZE === 0;
  const isSt = y % BLOCK_SIZE === 0;

  if (isAve || isSt) {
    // Intersection?
    if (isAve && isSt) return { type: 'road', subtype: 'intersection', capacity: 0 };
    return { type: 'road', subtype: 'asphalt', capacity: 0 };
  }

  // 2. Zoning Logic (Simple Clustering)
  // Center of map is busier (Commercial), edges are Residential
  const distFromCenter = Math.sqrt(Math.pow(x - GRID_SIZE_X/2, 2) + Math.pow(y - GRID_SIZE_Y/2, 2));
  const normalizedDist = distFromCenter / (Math.sqrt(Math.pow(GRID_SIZE_X, 2) + Math.pow(GRID_SIZE_Y, 2)) / 2);
  
  let type = 'building';
  let subtype = 'home';
  let capacity = 5; // Default home capacity

  // 20% chance of park
  if (Math.random() < 0.05) {
      type = 'park';
      subtype = 'public_park';
      capacity = 50;
  } 
  // Commercial zones closer to center
  else if (normalizedDist < 0.4 || Math.random() < 0.2) {
      const commercialTypes = ['bar', 'restaurant', 'store', 'office'];
      subtype = pickRandom(commercialTypes);
      capacity = subtype === 'office' ? 50 : 20;
  }

  // 3. Assign Meta Data (Names, Flavor)
  const meta = {};
  if (type === 'building' || type === 'park') {
      const nameList = LOCATION_NAMES[subtype] || LOCATION_NAMES['store'];
      // Assign a specific name occasionally, otherwise generic
      if (Math.random() > 0.5 && nameList.length > 0) {
          meta.name = pickRandom(nameList);
      } else {
          // Generate generic name: "Borough Subtype"
          meta.name = `Generic ${subtype.charAt(0).toUpperCase() + subtype.slice(1)}`;
      }
      
      // Rent / Economy (Simple placeholder based on your economic files)
      if (subtype === 'home') {
          meta.rent = Math.floor(800 + Math.random() * 1000); 
      }
  }

  return { type, subtype, capacity, meta };
}

async function genesis() {
  const pool = new Pool(DB_CONFIG);
  
  console.log('🌍 GENESIS: Connecting to database...');
  try {
    const client = await pool.connect();
    
    console.log('🔥 GENESIS: Wiping old world (Clean Slate)...');
    await client.query('TRUNCATE TABLE world_tiles CASCADE');
    await client.query('TRUNCATE TABLE agents CASCADE');
    await client.query('TRUNCATE TABLE world_objects CASCADE');

    console.log(`🏗️  GENESIS: Generating ${GRID_SIZE_X}x${GRID_SIZE_Y} Grid (${GRID_SIZE_X * GRID_SIZE_Y} tiles)...`);
    
    // Batch insert for performance
    const batchSize = 1000;
    let values = [];
    let count = 0;

    const flush = async () => {
        if (values.length === 0) return;
        // Construct bulk insert query
        // Note: pg library allows parameterized queries, but constructing a massive string 
        // is often faster for bulk loads if data is sanitized or generated internally. 
        // Using unnest is safest and cleanest for bulk arrays.
        
        const query = `
            INSERT INTO world_tiles (x, y, type, subtype, capacity, meta)
            SELECT * FROM UNNEST ($1::int[], $2::int[], $3::text[], $4::text[], $5::int[], $6::jsonb[])
        `;
        
        // Pivot data for UNNEST
        const xs = values.map(v => v.x);
        const ys = values.map(v => v.y);
        const types = values.map(v => v.type);
        const subtypes = values.map(v => v.subtype);
        const capacities = values.map(v => v.capacity);
        const metas = values.map(v => JSON.stringify(v.meta));

        await client.query(query, [xs, ys, types, subtypes, capacities, metas]);
        values = [];
        process.stdout.write('.');
    };

    for (let x = 0; x < GRID_SIZE_X; x++) {
      for (let y = 0; y < GRID_SIZE_Y; y++) {
        const tile = generateTile(x, y);
        values.push({ x, y, ...tile });
        count++;

        if (values.length >= batchSize) {
            await flush();
        }
      }
    }
    await flush(); // Final flush

    console.log(`\n✨ GENESIS COMPLETE: Created ${count} tiles.`);
    
    // Create a few test agents
    console.log('🤖 GENESIS: Spawning Adam and Eve (Test Agents)...');
    await client.query(`
        INSERT INTO agents (id, x, y, target_x, target_y, state, inventory)
        VALUES 
        (gen_random_uuid(), 10, 10, 10, 10, 'idle', '{"name": "Adam"}'::jsonb),
        (gen_random_uuid(), 20, 20, 20, 20, 'idle', '{"name": "Eve"}'::jsonb)
    `);

    client.release();
  } catch (err) {
    console.error('❌ GENESIS FAILED:', err);
  } finally {
    await pool.end();
  }
}

genesis();