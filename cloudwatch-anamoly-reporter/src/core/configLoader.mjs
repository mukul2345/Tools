#!/usr/bin/env node
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { fromIni } from "@aws-sdk/credential-providers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file
dotenv.config({ path: path.join(__dirname, "../../.env") });

const REGION = process.env.AWS_REGION || "eu-west-1";
const PROFILE = process.env.AWS_PROFILE || "prod";

/**
 * Load configuration from S3 (Lambda) or local file (CLI)
 */
export async function loadDashboardsConfig() {
  // Fallback to local config
  const localConfigPath = path.join(__dirname, "../../config/dashboards.json");
  if (fs.existsSync(localConfigPath)) {
    return JSON.parse(fs.readFileSync(localConfigPath, "utf-8"));
  }
  
  // Return default config
  return {
    signedUrlExpirySeconds: parseInt(process.env.S3_SIGNED_URL_EXPIRY_SECONDS || "86400"),
    googleChatWebhookSsmKey: process.env.GOOGLE_CHAT_WEBHOOK_SSM_KEY || "/cw-anom/staging/google-chat-webhook",
    dashboards: [],
  };
}

/**
 * Get dashboard-specific configuration
 */
export async function getDashboardConfig(dashboardName, overrides = {}) {
  const config = await loadDashboardsConfig();
  const dashboard = config.dashboards.find((d) => d.name === dashboardName);
  
  if (!dashboard) {
    throw new Error(`Dashboard ${dashboardName} not found in configuration`);
  }
  
  return {
    ...dashboard,
    ...overrides,
  };
}

/**
 * Load configuration.json file
 * This ensures we always use the same configuration source
 */
function loadConfigurationJson() {
  try {
    const configPath = path.join(__dirname, "../../configuration.json");
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, "utf-8"));
    }
  } catch (error) {
    console.warn(`Failed to load configuration.json: ${error.message}`);
  }
  return null;
}

/**
 * Get report configuration from configuration.json first, then environment variables, then defaults
 * This ensures consistency between CLI and Lambda flows
 */
export function getReportConfig(overrides = {}) {
  // Load configuration.json first (same source as analyze.mjs uses)
  const configJson = loadConfigurationJson();
  const reportConfig = configJson?.report || {};
  
  // Priority: overrides > configuration.json > env vars > defaults
  // This ensures configuration.json always takes precedence over environment variables
  return {
    periodSeconds: parseInt(
      overrides.periodSeconds ||
      reportConfig.periodSeconds ||
      process.env.REPORT_PERIOD_SECONDS ||
      "900"
    ),
    windowMinutes: parseInt(
      overrides.windowMinutes ||
      reportConfig.windowMinutes ||
      process.env.REPORT_WINDOW_MINUTES ||
      "300"
    ),
    baselineDays: parseInt(
      overrides.baselineDays ||
      reportConfig.baselineDays ||
      process.env.REPORT_BASELINE_DAYS ||
      "7"
    ),
    minSamples: parseInt(
      overrides.minSamples ||
      reportConfig.minSamples ||
      process.env.REPORT_MIN_SAMPLES ||
      "10"
    ),
    zThreshold: parseFloat(
      overrides.zThreshold ||
      reportConfig.zThreshold ||
      process.env.REPORT_Z_THRESHOLD ||
      "3.0"
    ),
    pctThreshold: parseInt(
      overrides.pctThreshold ||
      reportConfig.pctThreshold ||
      process.env.REPORT_PCT_THRESHOLD ||
      "40"
    ),
    timezone: overrides.timezone ||
      reportConfig.timezone ||
      process.env.REPORT_TIMEZONE ||
      "Asia/Kolkata",
    skipWeekends: overrides.skipWeekends !== undefined
      ? overrides.skipWeekends
      : reportConfig.skipWeekends !== undefined
      ? reportConfig.skipWeekends
      : process.env.REPORT_SKIP_WEEKENDS !== undefined
      ? process.env.REPORT_SKIP_WEEKENDS === "true"
      : true,
  };
}

/**
 * Get Google Chat webhook URL from SSM or env
 */
export async function getGoogleChatWebhook() {
  // First try environment variable
  if (process.env.GOOGLE_CHAT_WEBHOOK_URL) {
    return process.env.GOOGLE_CHAT_WEBHOOK_URL;
  }
  
  // Try SSM Parameter Store
  const ssmKey = process.env.GOOGLE_CHAT_WEBHOOK_SSM_KEY;
  if (ssmKey) {
    try {
      const ssmConfig = { region: REGION };
      // Only use profile if not in Lambda (Lambda uses IAM role)
      if (process.env.AWS_LAMBDA_FUNCTION_NAME === undefined && PROFILE) {
        ssmConfig.credentials = fromIni({ profile: PROFILE });
      }
      const ssmClient = new SSMClient(ssmConfig);
      
      const response = await ssmClient.send(
        new GetParameterCommand({
          Name: ssmKey,
          WithDecryption: true,
        })
      );
      
      return response.Parameter.Value;
    } catch (error) {
      console.warn(`Failed to load webhook from SSM: ${error.message}`);
    }
  }
  
  return null;
}

