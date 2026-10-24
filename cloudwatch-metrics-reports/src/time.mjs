/**
 * Time utilities for parsing and normalizing time ranges
 */

import { logger } from "./logger.mjs";

/**
 * Parse ISO datetime string to Date object
 * @param {string} isoString - ISO format datetime
 * @returns {Date}
 */
export function parseISODateTime(isoString) {
  const date = new Date(isoString);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid ISO datetime: ${isoString}`);
  }
  return date;
}

/**
 * Validate and normalize time range
 * @param {string} startISO - Start time in ISO format
 * @param {string} endISO - End time in ISO format
 * @returns {{start: Date, end: Date}}
 */
export function normalizeTimeRange(startISO, endISO) {
  const start = parseISODateTime(startISO);
  const end = parseISODateTime(endISO);

  if (start >= end) {
    throw new Error("Start time must be before end time");
  }

  logger.debug(`Time range: ${start.toISOString()} to ${end.toISOString()}`);

  return { start, end };
}

/**
 * Validate period is valid for CloudWatch
 * @param {number} periodSeconds
 * @returns {number}
 */
export function validatePeriod(periodSeconds) {
  if (!Number.isInteger(periodSeconds) || periodSeconds < 1) {
    throw new Error(
      `Invalid period: ${periodSeconds}. Must be a positive integer.`
    );
  }

  // CloudWatch requires period to be 1, 5, 10, 30, or a multiple of 60
  const validPeriods = [1, 5, 10, 30];
  if (!validPeriods.includes(periodSeconds) && periodSeconds % 60 !== 0) {
    logger.warn(
      `Period ${periodSeconds}s may not be optimal for CloudWatch. Consider using 60, 300, or 3600.`
    );
  }

  return periodSeconds;
}

/**
 * Get duration in seconds between two dates
 * @param {Date} start
 * @param {Date} end
 * @returns {number}
 */
export function getDurationSeconds(start, end) {
  return Math.floor((end - start) / 1000);
}
