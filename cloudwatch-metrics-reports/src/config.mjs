/**
 * Configuration loading and validation
 */

import { readFileSync } from "fs";
import { logger } from "./logger.mjs";

/**
 * Load and validate configuration from file
 * @param {string} configPath - Path to config JSON file
 * @returns {Object} - Validated configuration
 */
export function loadConfig(configPath) {
  try {
    const content = readFileSync(configPath, "utf8");
    const config = JSON.parse(content);

    validateConfig(config);
    logger.debug("Config loaded from", configPath);

    return config;
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Config file not found: ${configPath}`);
    }
    throw new Error(`Failed to load config: ${error.message}`);
  }
}

/**
 * Validate configuration shape and required fields
 * @param {Object} config
 */
function validateConfig(config) {
  const required = [
    "customNamespace",
    "services",
    "startISO",
    "endISO",
    "periodSeconds",
  ];

  for (const field of required) {
    if (!(field in config)) {
      throw new Error(`Missing required config field: ${field}`);
    }
  }

  if (!Array.isArray(config.services) || config.services.length === 0) {
    throw new Error("services must be a non-empty array");
  }

  if (typeof config.customNamespace !== "string" || !config.customNamespace) {
    throw new Error("customNamespace must be a non-empty string");
  }

  if (typeof config.periodSeconds !== "number" || config.periodSeconds < 1) {
    throw new Error("periodSeconds must be a positive number");
  }
}

/**
 * Apply CLI overrides to config
 * @param {Object} config - Base configuration
 * @param {Object} cliArgs - CLI arguments
 * @returns {Object} - Merged configuration
 */
export function applyOverrides(config, cliArgs) {
  const merged = { ...config };

  // Direct string/number overrides
  const directOverrides = [
    "customNamespace",
    "startISO",
    "endISO",
    "periodSeconds",
    "latencyThresholdMs",
    "errorThreshold",
    "latencyFilterMode",
    "errorFilterMode",
  ];

  for (const key of directOverrides) {
    if (cliArgs[key] !== undefined) {
      merged[key] = cliArgs[key];
      logger.debug(`CLI override: ${key} = ${cliArgs[key]}`);
    }
  }

  // Array overrides
  if (cliArgs.services) {
    merged.services = cliArgs.services;
  }
  if (cliArgs.statusCodesForLatency) {
    merged.statusCodesForLatency = cliArgs.statusCodesForLatency;
  }
  if (cliArgs.statusCodesForErrors) {
    merged.statusCodesForErrors = cliArgs.statusCodesForErrors;
  }
  if (cliArgs.trendServices) {
    merged.trendServices = cliArgs.trendServices;
  }
  if (cliArgs.trendWeeks) {
    merged.trendWeeks = cliArgs.trendWeeks;
  }

  // Ensure defaults
  merged.statusCodesForLatency = merged.statusCodesForLatency || ["200"];
  merged.statusCodesForErrors = merged.statusCodesForErrors || [
    "400",
    "500",
    "4XX",
  ];
  merged.latencyThresholdMs = merged.latencyThresholdMs ?? 100;
  merged.errorThreshold = merged.errorThreshold ?? 10;
  merged.latencyFilterMode = merged.latencyFilterMode || "below";
  merged.errorFilterMode = merged.errorFilterMode || "below";
  merged.modules = merged.modules || [
    "latency",
    "errors",
    "ecs-resources",
    "sqs-age",
    "lambda-performance",
    "top-apis",
  ];
  merged.topApisLimit = merged.topApisLimit ?? 20;
  merged.ecsClusterName = merged.ecsClusterName || "cluster-production-common";
  merged.ecsPeriodSeconds = merged.ecsPeriodSeconds ?? 300;
  merged.sqsQueueNames = merged.sqsQueueNames || [];
  merged.sqsPeriodSeconds = merged.sqsPeriodSeconds ?? 300;
  merged.lambdaFunctionNames = merged.lambdaFunctionNames || [];
  merged.lambdaPeriods = merged.lambdaPeriods || {
    invocationsPeriod: 300,
    durationPeriod: 300,
    errorsPeriod: 300,
    throttlesPeriod: 300,
  };

  // Validate filter modes
  const validModes = ["below", "above"];
  if (!validModes.includes(merged.latencyFilterMode)) {
    throw new Error(
      `Invalid latencyFilterMode: ${merged.latencyFilterMode}. Must be 'below' or 'above'.`
    );
  }
  if (!validModes.includes(merged.errorFilterMode)) {
    throw new Error(
      `Invalid errorFilterMode: ${merged.errorFilterMode}. Must be 'below' or 'above'.`
    );
  }

  // Validate modules
  const validModules = [
    "latency",
    "errors",
    "ecs-resources",
    "sqs-age",
    "lambda-performance",
    "top-apis",
    "traffic-trend",
  ];
  for (const module of merged.modules) {
    if (!validModules.includes(module)) {
      throw new Error(
        `Invalid module in config: ${module}. Must be one of: ${validModules.join(
          ", "
        )}`
      );
    }
  }

  // Validate ECS period
  if (
    typeof merged.ecsPeriodSeconds !== "number" ||
    merged.ecsPeriodSeconds < 1
  ) {
    throw new Error("ecsPeriodSeconds must be a positive number");
  }

  // Validate SQS configuration
  if (!Array.isArray(merged.sqsQueueNames)) {
    throw new Error("sqsQueueNames must be an array");
  }

  // Validate each queue has queueName and serviceName
  for (let i = 0; i < merged.sqsQueueNames.length; i++) {
    const queue = merged.sqsQueueNames[i];
    if (typeof queue !== "object" || queue === null) {
      throw new Error(
        `sqsQueueNames[${i}] must be an object with queueName and serviceName`
      );
    }
    if (typeof queue.queueName !== "string" || !queue.queueName) {
      throw new Error(
        `sqsQueueNames[${i}].queueName must be a non-empty string`
      );
    }
    if (typeof queue.serviceName !== "string" || !queue.serviceName) {
      throw new Error(
        `sqsQueueNames[${i}].serviceName must be a non-empty string`
      );
    }
  }

  if (
    typeof merged.sqsPeriodSeconds !== "number" ||
    merged.sqsPeriodSeconds < 1
  ) {
    throw new Error("sqsPeriodSeconds must be a positive number");
  }

  // Validate Lambda configuration
  if (!Array.isArray(merged.lambdaFunctionNames)) {
    throw new Error("lambdaFunctionNames must be an array");
  }

  // Validate each function has functionName and serviceName
  for (let i = 0; i < merged.lambdaFunctionNames.length; i++) {
    const func = merged.lambdaFunctionNames[i];
    if (typeof func !== "object" || func === null) {
      throw new Error(
        `lambdaFunctionNames[${i}] must be an object with functionName and serviceName`
      );
    }
    if (typeof func.functionName !== "string" || !func.functionName) {
      throw new Error(
        `lambdaFunctionNames[${i}].functionName must be a non-empty string`
      );
    }
    if (typeof func.serviceName !== "string" || !func.serviceName) {
      throw new Error(
        `lambdaFunctionNames[${i}].serviceName must be a non-empty string`
      );
    }
  }

  if (
    typeof merged.lambdaPeriods !== "object" ||
    merged.lambdaPeriods === null
  ) {
    throw new Error("lambdaPeriods must be an object");
  }

  const requiredPeriods = [
    "invocationsPeriod",
    "durationPeriod",
    "errorsPeriod",
    "throttlesPeriod",
  ];

  for (const periodKey of requiredPeriods) {
    if (
      typeof merged.lambdaPeriods[periodKey] !== "number" ||
      merged.lambdaPeriods[periodKey] < 1
    ) {
      throw new Error(`lambdaPeriods.${periodKey} must be a positive number`);
    }
  }

  return merged;
}

/**
 * Get full validated configuration
 * @param {string} configPath
 * @param {Object} cliArgs
 * @returns {Object}
 */
export function getConfig(configPath, cliArgs) {
  const baseConfig = loadConfig(configPath);
  const finalConfig = applyOverrides(baseConfig, cliArgs);

  logger.debug("Final config:", JSON.stringify(finalConfig, null, 2));

  return finalConfig;
}
