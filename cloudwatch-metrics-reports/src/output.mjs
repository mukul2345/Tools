/**
 * File output utilities
 */

import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { logger } from "./logger.mjs";

/**
 * Generate a human-readable filename with timestamp
 * @param {string} prefix - File prefix (e.g., "latency", "errors")
 * @param {string} filterMode - "below" or "above"
 * @param {string} extension - File extension without dot (e.g., "md", "csv")
 * @returns {string} - Filename
 */
export function generateFilename(prefix, filterMode, extension) {
  const now = new Date();

  // Format: latency-above-2025-11-03-14-30-45.md
  const timestamp = now
    .toISOString()
    .replace(/T/, "-")
    .replace(/:/g, "-")
    .replace(/\..+/, ""); // Remove milliseconds and timezone

  return `${prefix}-${filterMode}-${timestamp}.${extension}`;
}

/**
 * Write content to file
 * @param {string} filename - Output filename
 * @param {string} content - File content
 * @param {string} outputDir - Output directory (default: './output')
 * @returns {string} - Full path of written file
 */
export function writeFile(filename, content, outputDir = "./output") {
  try {
    // Create output directory if it doesn't exist
    mkdirSync(outputDir, { recursive: true });

    const filePath = join(outputDir, filename);
    writeFileSync(filePath, content, "utf8");

    logger.info(`✅ Written: ${filePath}`);
    return filePath;
  } catch (error) {
    throw new Error(`Failed to write file ${filename}: ${error.message}`);
  }
}

/**
 * Generate summary of written files
 * @param {Array<{type: string, path: string}>} files
 * @returns {string}
 */
export function generateFileSummary(files) {
  let summary = "\n📁 Generated Files:\n";
  summary += "=".repeat(50) + "\n";

  for (const file of files) {
    summary += `  ${file.type.padEnd(20)} ${file.path}\n`;
  }

  summary += "=".repeat(50) + "\n";

  return summary;
}
