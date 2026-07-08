import readline from 'readline';
import Matrix from './engine/matrix.js';
import logger from './logger.js';

// --- ROBUST ARGUMENT PARSING ---
const args = process.argv.slice(2).reduce((acc, arg) => {
    if (arg === '--help') {
        console.log(`
Usage: node index.js [options]

Options:
  --agents=N      Set initial number of agents (default: config.js value)
  --headless      Run without the TUI (Terminal User Interface)
  --debug         Enable debug logging
  --help          Show this help message
        `);
        process.exit(0);
    }
    const [key, value] = arg.replace(/^--/, '').split('=');
    acc[key] = value || true;
    return acc;
}, {});

if (args.agents) process.env.INITIAL_AGENTS = args.agents;
if (args.debug) process.env.DEBUG = 'true';

process.title = 'nyc-1999-sim';
let simulator = null;
let isShuttingDown = false;

// --- TUI MANAGEMENT ---
function cleanupTUI() {
  if (global.dashboard && typeof global.dashboard.emergencyShutdown === 'function') {
      try { global.dashboard.emergencyShutdown(); } catch (e) {
          // Ignore TUI errors during cleanup
      }
  }
}

// --- GRACEFUL SHUTDOWN ---
async function gracefulShutdown(exitCode = 0, reason = 'Unknown') {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`[INDEX] Initiating graceful shutdown... Reason: ${reason}`);
  
  cleanupTUI();

  try {
    if (simulator) {
        logger.info('[INDEX] Stopping Game Loop...');
        await simulator.stop(); 

        if (simulator.dbService) {
            logger.info('[INDEX] Persisting State...');
            // Guard against partial initialization
            if (simulator.cacheManager) {
                const allAgents = simulator.cacheManager.getAllAgents();
                await simulator.dbService.syncAgents(allAgents);
            }
            await simulator.dbService.createCheckpoint(simulator.tickCount);
            logger.info('[INDEX] Database sync & checkpoint complete.');
        }
    }
  } catch (err) {
    logger.error(`[INDEX] !!! Error during shutdown sequence !!! ${err.message}`);
    exitCode = 1;
  }
  
  logger.info('[INDEX] Goodbye.');
  setTimeout(() => process.exit(exitCode), 500);
}

// --- GLOBAL ERROR HANDLERS ---
process.on('uncaughtException', (error) => {
  logger.error(`[FATAL] Uncaught Exception: ${error.message}\n${error.stack}`);
  cleanupTUI(); 
  setTimeout(() => process.exit(1), 500);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('[FATAL] Unhandled Rejection:', reason);
});

// --- INTERACTIVE CLI (Headless Mode Only) ---
function setupInteractiveMode() {
    // Only attach these listeners if we are strictly in headless mode.
    // Otherwise, they fight with Blessed/Dashboard for stdin control.
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    process.stdin.on('keypress', async (str, key) => {
        if (key.ctrl && key.name === 'c') {
            await gracefulShutdown(0, 'SIGINT (Ctrl+C)');
            return;
        }

        if (!simulator || isShuttingDown) return;

        switch (key.name) {
            case 'q':
                await gracefulShutdown(0, 'User Keypress (q)');
                break;
            case 's':
                logger.info("[CLI] Manual Save Triggered...");
                try {
                    const allAgents = simulator.cacheManager.getAllAgents();
                    await simulator.dbService.syncAgents(allAgents);
                    await simulator.dbService.createCheckpoint(simulator.tickCount);
                    logger.info("[CLI] Save Successful.");
                } catch (err) {
                    logger.error(`[CLI] Save Failed: ${err.message}`);
                }
                break;
            case 'd':
                if (simulator.eventBus) {
                    const newDebug = !simulator.eventBus.debug;
                    simulator.eventBus.setDebug(newDebug);
                    logger.info(`[CLI] Debug Mode: ${newDebug ? 'ON' : 'OFF'}`);
                }
                break;
        }
    });
}

// --- MAIN ---
async function main() {
  try {
    logger.info('[INDEX] Booting Matrix...');
    
    simulator = new Matrix();
    
    // Wire up event listeners
    if (simulator.eventBus) {
        simulator.eventBus.on('system:error', (data) => {
            logger.error(`[MATRIX ERROR] Tick ${data.tick}: ${data.error}`);
        });
        
        // Listen for Dashboard-initiated shutdown
        simulator.eventBus.on('system:shutdown', async () => {
            await gracefulShutdown(0, 'Dashboard Request');
        });
    }

    logger.info('[INDEX] Initializing Simulator...');
    simulator.init();
    
    logger.info('[INDEX] Starting Simulation Loop...');
    await simulator.start();
    
    // INPUT ISOLATION: Only enable CLI keys if TUI is NOT running.
    // This prevents mouse reporting bytes from being misinterpreted as 'q' or 'Ctrl+C'
    if (args.headless) {
        setupInteractiveMode();
        logger.info('[INDEX] Headless Mode: Press "q" to quit, "s" to save.');
    } else {
        logger.info('[INDEX] TUI Mode: Use Dashboard controls to exit.');
    }

  } catch (err) {
    logger.error(`[INDEX] Failed to start simulation: ${err.message}\n${err.stack}`);
    cleanupTUI();
    process.exit(1);
  }
}

main();