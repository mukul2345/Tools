#!/usr/bin/env node
/**
 * Anomaly Engine - Core anomaly detection logic
 * This module wraps the existing analyzeConfig function without modifications
 */

import { analyzeConfig } from "../../analyze.mjs";
import { getReportConfig } from "./configLoader.mjs";

/**
 * Run anomaly detection on a dashboard configuration
 * @param {Object} config - Dashboard configuration with series
 * @param {Object} options - Options including endISO
 * @returns {Promise<Object>} Analysis results with rows and metadata
 */
export async function runAnomalyDetection(config, options = {}) {
  // Merge report config from env with any overrides
  const reportConfig = getReportConfig();
  
  // Apply report config to the dashboard config
  const mergedConfig = {
    ...config,
    periodSeconds: config.periodSeconds || reportConfig.periodSeconds,
    windowMinutes: config.windowMinutes || reportConfig.windowMinutes,
    baselineDays: config.baselineDays || reportConfig.baselineDays,
    minSamples: config.minSamples ?? reportConfig.minSamples,
    zThreshold: config.zThreshold ?? reportConfig.zThreshold,
    pctThreshold: config.pctThreshold ?? reportConfig.pctThreshold,
    timezone: config.timezone || reportConfig.timezone,
    skipWeekends: config.skipWeekends !== undefined ? config.skipWeekends : reportConfig.skipWeekends,
  };
  
  // Call the existing analyzeConfig function (unchanged)
  return await analyzeConfig(mergedConfig, options);
}

