import winston from 'winston';

// Determine if we're in headless mode (no UI)
const isHeadless = process.argv.includes('--headless');

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Define a custom format for the console
const consoleFormat = printf(({ level, message, timestamp, stack }) => {
  return `${timestamp} ${level}: ${message} ${stack || ''}`;
});

// Define a custom format for the file (includes level and stack trace)
const fileFormat = printf(({ level, message, timestamp, stack }) => {
  return `${timestamp} [${level.toUpperCase().padEnd(7)}] ${message} ${stack || ''}`;
});

const logger = winston.createLogger({
  level: 'debug', 
  format: combine(
    errors({ stack: true }), // CRITICAL: Tells winston to capture stack traces
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    fileFormat
  ),
  transports: [
    // 1. Debug Log: The comprehensive timeline
    new winston.transports.File({ 
      filename: 'debug.log', 
      level: 'debug',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      tailable: true
    }),
    
    // 2. Error Log: Catches normal errors AND fatal crashes
    new winston.transports.File({ 
      filename: 'error.log', 
      level: 'error',
      handleExceptions: true, // <--- CATCHES CRASHES
      handleRejections: true  // <--- CATCHES PROMISE FAILURES
    }),
  ],
  exitOnError: true, // Let winston handle the exit after logging the exception
});

//
// Console logging logic
//
if (isHeadless) {
  logger.add(new winston.transports.Console({
    format: combine(
      colorize(),
      timestamp({ format: 'HH:mm:ss.SSS' }),
      consoleFormat
    ),
    level: 'info', 
    handleExceptions: true, // Also show crash in console
    handleRejections: true
  }));
}

export default logger;