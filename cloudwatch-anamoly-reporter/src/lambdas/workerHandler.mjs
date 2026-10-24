#!/usr/bin/env node
/**
 * Worker Lambda Handler - Processes a single dashboard
 * Downloads fresh configs from CloudWatch before generating reports
 */

import { generateReport } from "../core/generateReport.mjs";
import { postToGoogleChat } from "../core/googleChat.mjs";
import { generateSignedUrl } from "../core/storage.mjs";
import { downloadDashboardConfigs } from "../core/dashboardDownloader.mjs";

/**
 * Lambda handler for processing a single dashboard
 * @param {Object} event - Lambda event
 * @param {string} event.dashboardName - Dashboard name
 * @param {Object} event.overrides - Configuration overrides
 * @param {string} event.endISO - End time for analysis
 * @returns {Promise<Object>} Lambda response
 */
export async function handler(event) {
  const runId = event.runId || `run-${Date.now()}`;
  const dashboardName = event.dashboardName;
  const overrides = event.overrides || {};
  const endISO = event.endISO || null;

  const startTime = Date.now();

  try {
    console.log(`[${runId}] Processing dashboard: ${dashboardName}`);

    // Step 1: Download fresh configs from CloudWatch dashboard
    console.log(`[${runId}] Step 1: Downloading dashboard configs from CloudWatch...`);
    try {
      const downloadResult = await downloadDashboardConfigs(dashboardName);
      console.log(`[${runId}] ✅ Downloaded ${downloadResult.configCount} config files`);
    } catch (downloadError) {
      console.error(`[${runId}] ⚠️  Failed to download configs: ${downloadError.message}`);
      console.error(`[${runId}] Attempting to use existing configs if available...`);
      // Continue with existing configs if download fails (for backward compatibility)
    }

    // Step 2: Generate report using downloaded configs
    console.log(`[${runId}] Step 2: Generating anomaly report...`);
    let result;
    try {
      result = await generateReport({
        dashboardName,
        overrides,
        outputMode: "lambda",
        endISO,
      });
    } catch (reportError) {
      // If report generation fails, return error response
      console.error(`[${runId}] ❌ Report generation failed: ${reportError.message}`);
      return {
        statusCode: 200,
        body: JSON.stringify({
          status: "error",
          dashboardName,
          error: reportError.message,
          durationMs: Date.now() - startTime,
        }),
      };
    }

    const durationMs = Date.now() - startTime;

    // Send notification to Google Chat
    // IMPORTANT: Only share AWS Console URL if upload was successful
    // The AWS Console URL requires AWS Console login and proper IAM permissions
    try {
      const message = `✅ Anomaly report for ${dashboardName}\n\n` +
        `📊 Anomalies: ${result.anomaliesFound} / ${result.totalMetrics} metrics\n` +
        `🕐 Generated: ${new Date(result.timestamp).toLocaleString()}\n` +
        `📦 S3 Key: ${result.s3Key}`;
      
      // Only share AWS Console URL if it was successfully generated (upload succeeded)
      if (result.signedUrl) {
      await postToGoogleChat(message, result.signedUrl);
        console.log(`[${runId}] ✅ Notification sent to Google Chat with AWS Console S3 URL (requires AWS Console login to access)`);
      } else {
        // Upload failed, don't share URL
        await postToGoogleChat(message + `\n\n⚠️ Note: S3 upload failed, no AWS Console URL available`);
        console.log(`[${runId}] ⚠️  Notification sent without AWS Console URL (S3 upload failed)`);
      }
    } catch (error) {
      console.error(`[${runId}] Failed to send notification: ${error.message}`);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        runId,
        dashboardName,
        status: "success",
        anomaliesFound: result.anomaliesFound,
        totalMetrics: result.totalMetrics,
        s3Key: result.s3Key,
        signedUrl: result.signedUrl,
        durationMs,
      }),
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    console.error(`[${runId}] Error processing dashboard: ${error.message}`);
    console.error(error.stack);

    // Send error notification
    try {
      const errorMessage = `❌ Error generating report for ${dashboardName}\n\n` +
        `Error: ${error.message}\n` +
        `Run ID: ${runId}`;
      
      await postToGoogleChat(errorMessage);
    } catch (notifError) {
      console.error(`[${runId}] Failed to send error notification: ${notifError.message}`);
    }

    return {
      statusCode: 500,
      body: JSON.stringify({
        runId,
        dashboardName,
        status: "error",
        error: error.message,
        durationMs,
      }),
    };
  }
}

