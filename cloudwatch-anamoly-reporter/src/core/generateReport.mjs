#!/usr/bin/env node
/**
 * Generate Report - Main orchestration function
 * Always generates HTML first, then:
 * - Local mode: Saves HTML to local filesystem
 * - Lambda mode: Uploads HTML to S3 and generates signed URL
 */

import { runAnomalyDetection } from "./anomalyEngine.mjs";
import { renderHTML } from "./htmlReport.mjs";
import { uploadHtmlToS3, generateSignedUrl } from "./storage.mjs";
import fs from "fs";
import path from "path";

const REGION = process.env.AWS_REGION || "eu-west-1";
const PROFILE = process.env.AWS_PROFILE || "prod";

/**
 * Find the actual config directory name by checking manifest files
 * Dashboard names in dashboards.json may differ from folder names (e.g., "Verification_Platform_Performance" -> "Verification")
 * In Lambda, configs are in /tmp/configs, locally in configs/
 */
function findConfigDirectory(dashboardName) {
  // Check /tmp/configs first (Lambda), then configs/ (local)
  const lambdaConfigsDir = path.join("/tmp", "configs");
  const localConfigsDir = path.join(process.cwd(), "configs");
  
  // Try Lambda location first, then local
  const configsBaseDir = fs.existsSync(lambdaConfigsDir) ? lambdaConfigsDir : localConfigsDir;
  const isLambda = configsBaseDir === lambdaConfigsDir;
    
  if (!fs.existsSync(configsBaseDir)) {
    if (isLambda) {
      throw new Error(`Configs directory not found: ${configsBaseDir}. Configs should be downloaded first.`);
    } else {
      throw new Error(`Configs directory not found: ${configsBaseDir}. Please run dashboard-to-configs.mjs first.`);
    }
  }

  // First, try direct match
  const directPath = path.join(configsBaseDir, dashboardName);
  if (fs.existsSync(directPath)) {
    return dashboardName;
  }

  // Search through all config directories for manifest files
  const subdirs = fs.readdirSync(configsBaseDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const subdir of subdirs) {
    const manifestFiles = fs.readdirSync(path.join(configsBaseDir, subdir))
      .filter(f => f.startsWith("manifest.") && f.endsWith(".json"));

    for (const manifestFile of manifestFiles) {
      try {
        const manifestPath = path.join(configsBaseDir, subdir, manifestFile);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        if (manifest.dashboardName === dashboardName) {
          return subdir;
        }
      } catch (e) {
        // Skip invalid manifest files
        continue;
      }
    }
  }

  // If not found, throw error with helpful message
  if (isLambda) {
    throw new Error(
      `Dashboard config directory not found for "${dashboardName}" in /tmp/configs. ` +
      `Configs should be downloaded before report generation.`
    );
  } else {
    throw new Error(
      `Dashboard config directory not found for "${dashboardName}". ` +
      `Please run: node dashboard-to-configs.mjs "${dashboardName}" --profile=prod --region=eu-west-1`
    );
  }
}

/**
 * Fetch dashboard configurations from configs directory
 * In Lambda: /tmp/configs/{folderName}
 * Locally: configs/{folderName}
 */
async function fetchDashboardConfigs(dashboardName) {
  const folderName = findConfigDirectory(dashboardName);
  
  // Check /tmp/configs first (Lambda), then configs/ (local)
  const lambdaConfigsDir = path.join("/tmp", "configs", folderName);
  const localConfigsDir = path.join(process.cwd(), "configs", folderName);
  
  const configsDir = fs.existsSync(lambdaConfigsDir) ? lambdaConfigsDir : localConfigsDir;
  
  if (!fs.existsSync(configsDir)) {
    throw new Error(`Dashboard config directory not found: ${configsDir}. Please run dashboard-to-configs.mjs first.`);
  }

  const files = fs.readdirSync(configsDir).filter((f) => f.endsWith(".json") && !f.startsWith("manifest."));
  if (files.length === 0) {
    throw new Error(`No config files found in ${configsDir}`);
  }

  return files.map((file) => {
    const configPath = path.join(configsDir, file);
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  });
}

/**
 * Generate complete report for a dashboard
 * @param {Object} options
 * @param {string} options.dashboardName - Dashboard name
 * @param {Object} options.overrides - Configuration overrides
 * @param {string} options.outputMode - 'local' or 'lambda'
 * @param {Date} options.endISO - End time for analysis
 * @returns {Promise<Object>} Report result with HTML path (local) or signed URL (Lambda)
 */
export async function generateReport({ dashboardName, overrides = {}, outputMode = "local", endISO = null }) {
  // Fetch all dashboard configurations
  const configs = await fetchDashboardConfigs(dashboardName);
  
  // Process all configs in parallel for faster execution (optimized for 1-minute Lambda)
  const analysisPromises = configs.map(async (config) => {
    // Apply overrides
    const mergedConfig = { ...config, ...overrides };
    
    // Run anomaly detection
    return await runAnomalyDetection(mergedConfig, { endISO });
  });
  
  const analysisResults = await Promise.all(analysisPromises);

  // Render HTML with all results
  const html = renderHTML([{ results: analysisResults }], dashboardName);

  const timestamp = new Date();

  // Calculate totals
  const totalAnomalies = analysisResults.reduce((sum, r) => sum + r.rows.filter((row) => row.anomaly).length, 0);
  const totalMetrics = analysisResults.reduce((sum, r) => sum + r.rows.length, 0);

  // Save based on output mode
  if (outputMode === "lambda") {
    // Lambda mode: Upload HTML to S3 (HTML only - no PDF conversion)
    const htmlBuffer = Buffer.from(html, "utf-8");
    let s3Key, signedUrl;
    try {
      // Step 1: Upload to S3 and verify upload was successful
      s3Key = await uploadHtmlToS3(htmlBuffer, dashboardName, timestamp);
      console.log(`✅ Successfully uploaded report to S3: ${s3Key}`);
      
      // Step 2: Only generate AWS Console URL after successful upload
      // The AWS Console URL requires AWS Console login and proper IAM permissions
      signedUrl = await generateSignedUrl(s3Key);
      console.log(`✅ Generated AWS Console S3 URL (requires AWS Console login to access)`);
    } catch (s3Error) {
      // If S3 upload fails (e.g., bucket doesn't exist in local testing), save locally instead
      console.warn(`⚠️  S3 upload failed: ${s3Error.message}, saving locally instead`);
      const htmlDir = path.join(process.cwd(), "reports", dashboardName);
      if (!fs.existsSync(htmlDir)) {
        fs.mkdirSync(htmlDir, { recursive: true });
      }
      const timestampStr = timestamp.toISOString().replace(/[:.]/g, "-");
      const htmlPath = path.join(htmlDir, `${dashboardName}-${timestampStr}.html`);
      fs.writeFileSync(htmlPath, html, "utf-8");
      s3Key = `local:${htmlPath}`;
      // IMPORTANT: Do not generate or share URL if upload failed
      signedUrl = null;
    }

    return {
      dashboardName,
      s3Key,
      signedUrl, // Will be null if upload failed
      anomaliesFound: totalAnomalies,
      totalMetrics: totalMetrics,
      timestamp: timestamp.toISOString(),
    };
  } else {
    // Local mode: Save HTML to local filesystem and upload to S3 for Google Chat link
    const htmlDir = path.join(process.cwd(), "reports", dashboardName);
    if (!fs.existsSync(htmlDir)) {
      fs.mkdirSync(htmlDir, { recursive: true });
    }
    
    const timestampStr = timestamp.toISOString().replace(/[:.]/g, "-");
    const htmlPath = path.join(htmlDir, `${dashboardName}-${timestampStr}.html`);
    fs.writeFileSync(htmlPath, html, "utf-8");
    
    // Upload to S3 and generate presigned URL only if upload succeeds
    let signedUrl = null;
    try {
    const htmlBuffer = Buffer.from(html, "utf-8");
    const s3Key = await uploadHtmlToS3(htmlBuffer, dashboardName, timestamp);
      console.log(`✅ Successfully uploaded report to S3: ${s3Key}`);
      
      // Only generate AWS Console URL after successful upload
      // The AWS Console URL requires AWS Console login and proper IAM permissions
      signedUrl = await generateSignedUrl(s3Key);
      console.log(`✅ Generated AWS Console S3 URL (requires AWS Console login to access)`);
    } catch (s3Error) {
      console.warn(`⚠️  S3 upload failed: ${s3Error.message}, skipping presigned URL generation`);
      // Do not generate or share URL if upload failed
    }
    
    return {
      dashboardName,
      localPath: htmlPath,
      signedUrl: signedUrl, // Will be null if upload failed
      anomaliesFound: totalAnomalies,
      totalMetrics: totalMetrics,
      timestamp: timestamp.toISOString(),
    };
  }
}

