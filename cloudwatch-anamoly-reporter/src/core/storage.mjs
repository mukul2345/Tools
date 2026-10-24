#!/usr/bin/env node
/**
 * Storage - S3 upload and local file write helpers
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") });

const REGION = process.env.AWS_REGION || "eu-west-1";
const PROFILE = process.env.AWS_PROFILE || "prod";
const BUCKET = process.env.S3_BUCKET || "cw-anom-reports-staging";
const REPORTS_PREFIX = process.env.S3_REPORTS_PREFIX || "reports";
const SIGNED_URL_EXPIRY = parseInt(process.env.S3_SIGNED_URL_EXPIRY_SECONDS || "86400");

/**
 * Get S3 client with proper credentials
 * @returns {S3Client} Configured S3 client
 */
function getS3Client() {
  const s3Config = { region: REGION };
  // Only use profile if not in Lambda (Lambda uses IAM role)
  if (process.env.AWS_LAMBDA_FUNCTION_NAME === undefined && PROFILE) {
    s3Config.credentials = fromIni({ profile: PROFILE });
  }
  return new S3Client(s3Config);
}

/**
 * Verify that an object exists in S3
 * @param {string} key - S3 key
 * @returns {Promise<boolean>} True if object exists, false otherwise
 */
async function verifyObjectExists(key) {
  const s3Client = getS3Client();
  try {
    await s3Client.send(
      new HeadObjectCommand({
        Bucket: BUCKET,
        Key: key,
      })
    );
    return true;
  } catch (error) {
    if (error.name === "NotFound" || error.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
}

/**
 * Upload HTML report to S3
 * @param {Buffer} htmlBuffer - HTML buffer
 * @param {string} dashboardName - Dashboard name
 * @param {Date} timestamp - Report timestamp
 * @returns {Promise<string>} S3 key
 * @throws {Error} If upload fails
 */
export async function uploadHtmlToS3(htmlBuffer, dashboardName, timestamp = new Date()) {
  const dateStr = timestamp.toISOString().split("T")[0]; // YYYY-MM-DD
  const timestampStr = timestamp.toISOString().replace(/[:.]/g, "-");
  const key = `${REPORTS_PREFIX}/${dashboardName}/${dateStr}/${dashboardName}-${timestampStr}.html`;

  const s3Client = getS3Client();

  // Upload the file
  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: htmlBuffer,
      ContentType: "text/html",
      CacheControl: "max-age=3600", // Cache for 1 hour
    })
  );

  // Verify the upload was successful by checking if object exists
  const exists = await verifyObjectExists(key);
  if (!exists) {
    throw new Error(`Upload verification failed: Object ${key} not found in S3 after upload`);
  }

  return key;
}

/**
 * Generate AWS Console S3 URL for S3 object
 * IMPORTANT: This generates an AWS Console URL that requires AWS Console login and proper IAM permissions.
 * The URL will only work if the user is logged into AWS Console and has access to the S3 bucket.
 * This is more secure than presigned URLs as it requires AWS authentication, not just a URL signature.
 * @param {string} key - S3 key (must exist in S3)
 * @returns {Promise<string>} AWS Console S3 URL that requires AWS Console login
 * @throws {Error} If object doesn't exist
 */
export async function generateConsoleUrl(key) {
  // First verify the object exists before generating the console URL
  const exists = await verifyObjectExists(key);
  if (!exists) {
    throw new Error(`Cannot generate console URL: Object ${key} does not exist in S3`);
  }

  // Generate AWS Console S3 URL format:
  // https://{region}.console.aws.amazon.com/s3/object/{bucket}?region={region}&prefix={key}
  const encodedKey = encodeURIComponent(key);
  const consoleUrl = `https://${REGION}.console.aws.amazon.com/s3/object/${BUCKET}?region=${REGION}&prefix=${encodedKey}`;
  
  return consoleUrl;
}

/**
 * @deprecated Use generateConsoleUrl instead. This function is kept for backward compatibility.
 * Generate pre-signed URL for S3 object (NOT RECOMMENDED - use generateConsoleUrl for security)
 * @param {string} key - S3 key (must exist in S3)
 * @param {number} expirySeconds - URL expiry in seconds (ignored, kept for compatibility)
 * @returns {Promise<string>} AWS Console S3 URL
 */
export async function generateSignedUrl(key, expirySeconds = SIGNED_URL_EXPIRY) {
  // Redirect to console URL for security
  return await generateConsoleUrl(key);
}


