/**
 * Minimal logger that honors LOG_LEVEL environment variable
 * Logs to stderr to avoid contaminating stdout tables
 */

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const currentLevel =
  LOG_LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LOG_LEVELS.info;

function log(level, ...args) {
  if (LOG_LEVELS[level] <= currentLevel) {
    const timestamp = new Date().toISOString();
    const emoji =
      {
        error: "❌",
        warn: "⚠️",
        info: "ℹ️",
        debug: "🔍",
      }[level] || "";

    console.error(`[${timestamp}] ${emoji} [${level.toUpperCase()}]`, ...args);
  }
}

export const logger = {
  error: (...args) => log("error", ...args),
  warn: (...args) => log("warn", ...args),
  info: (...args) => log("info", ...args),
  debug: (...args) => log("debug", ...args),
};
