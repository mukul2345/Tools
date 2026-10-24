/**
 * Load and normalize alarms config. Single source of truth for the standalone module.
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_CONFIG = {
  aws: { profile: "default", region: "eu-west-1" },
  tags: [{ Key: "Team", Value: "" }],
  naming: {},
  modules: { ecs: true, "api-5xx": true, "api-traffic": true, sqs: true },
  resources: {},
  alarms: {},
  deleteFilters: { Team: null, AlarmType: null },
};

export function loadConfig(configPath) {
  const path = configPath || join(__dirname, "..", "..", "alarms.config.json");
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") throw new Error(`Config not found: ${path}`);
    throw new Error(`Invalid config: ${err.message}`);
  }
  const config = {
    aws: { ...DEFAULT_CONFIG.aws, ...raw.aws },
    tags: Array.isArray(raw.tags) ? raw.tags : DEFAULT_CONFIG.tags,
    naming: { ...DEFAULT_CONFIG.naming, ...raw.naming },
    modules: { ...DEFAULT_CONFIG.modules, ...raw.modules },
    resources: { ...DEFAULT_CONFIG.resources, ...raw.resources },
    alarms: { ...DEFAULT_CONFIG.alarms, ...raw.alarms },
    deleteFilters: { ...DEFAULT_CONFIG.deleteFilters, ...raw.deleteFilters },
  };
  if (!config.tags.some((t) => t.Key === "Team")) {
    throw new Error("config.tags must include a tag with Key 'Team'");
  }
  return config;
}
