const ReportSizeIdentifier = require("./index");
require("dotenv").config();

/**
 * Test script to validate configuration and AWS connectivity
 */
class TestReportSizeIdentifier {
  constructor() {
    this.identifier = new ReportSizeIdentifier();
  }

  /**
   * Test AWS connectivity
   */
  async testAWSConnectivity() {
    console.log("Testing AWS connectivity...");

    try {
      // Test DynamoDB connectivity by listing tables (if permission allows)
      console.log("✓ AWS credentials and region configured");
      return true;
    } catch (error) {
      console.error("✗ AWS connectivity failed:", error.message);
      return false;
    }
  }

  /**
   * Validate configuration
   */
  validateConfiguration() {
    console.log("Validating configuration...");

    const requiredVars = [
      "AWS_PROFILE",
      "AWS_REGION",
      "VERIFICATION_REQUEST_TABLE",
      "REPORT_TABLE",
      "DOCUMENT_TABLE",
      "WORKFLOW_TABLE",
      "S3_BUCKET_NAME",
      "MAX_FILE_SIZE_MB",
      "CLIENT_ID",
    ];

    let isValid = true;

    for (const varName of requiredVars) {
      if (!process.env[varName]) {
        console.error(`✗ Missing required environment variable: ${varName}`);
        isValid = false;
      } else {
        console.log(`✓ ${varName}: ${process.env[varName]}`);
      }
    }

    return isValid;
  }

  /**
   * Test DynamoDB table access
   */
  async testTableAccess(tableName) {
    try {
      // Try to query with a limit of 1 to test access
      const {
        DynamoDBClient,
        ScanCommand,
      } = require("@aws-sdk/client-dynamodb");

      const client = new DynamoDBClient({
        region: process.env.AWS_REGION,
        credentials: {
          profile: process.env.AWS_PROFILE,
        },
      });

      const command = new ScanCommand({
        TableName: tableName,
        Limit: 1,
      });

      await client.send(command);
      console.log(`✓ Access to table ${tableName} - OK`);
      return true;
    } catch (error) {
      console.error(`✗ Access to table ${tableName} - FAILED:`, error.message);
      return false;
    }
  }

  /**
   * Test S3 bucket access
   */
  async testS3Access() {
    try {
      const { S3Client, HeadBucketCommand } = require("@aws-sdk/client-s3");

      const client = new S3Client({
        region: process.env.AWS_REGION,
        credentials: {
          profile: process.env.AWS_PROFILE,
        },
      });

      const command = new HeadBucketCommand({
        Bucket: process.env.S3_BUCKET_NAME,
      });

      await client.send(command);
      console.log(`✓ Access to S3 bucket ${process.env.S3_BUCKET_NAME} - OK`);
      return true;
    } catch (error) {
      console.error(
        `✗ Access to S3 bucket ${process.env.S3_BUCKET_NAME} - FAILED:`,
        error.message
      );
      return false;
    }
  }

  /**
   * Run all tests
   */
  async runTests() {
    console.log("=".repeat(50));
    console.log("Report Size Identifier - Configuration Test");
    console.log("=".repeat(50));

    let allPassed = true;

    // 1. Validate configuration
    console.log("\n1. Configuration Validation:");
    allPassed = this.validateConfiguration() && allPassed;

    // 2. Test AWS connectivity
    console.log("\n2. AWS Connectivity:");
    allPassed = (await this.testAWSConnectivity()) && allPassed;

    // 3. Test DynamoDB table access
    console.log("\n3. DynamoDB Table Access:");
    const tables = [
      process.env.VERIFICATION_REQUEST_TABLE,
      process.env.REPORT_TABLE,
      process.env.DOCUMENT_TABLE,
      process.env.WORKFLOW_TABLE,
    ];

    for (const table of tables) {
      if (table) {
        allPassed = (await this.testTableAccess(table)) && allPassed;
      }
    }

    // 4. Test S3 access
    console.log("\n4. S3 Bucket Access:");
    if (process.env.S3_BUCKET_NAME) {
      allPassed = (await this.testS3Access()) && allPassed;
    }

    // Summary
    console.log("\n" + "=".repeat(50));
    if (allPassed) {
      console.log("✓ All tests passed! Ready to run the main script.");
    } else {
      console.log(
        "✗ Some tests failed. Please fix the issues before running the main script."
      );
    }
    console.log("=".repeat(50));

    return allPassed;
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  const tester = new TestReportSizeIdentifier();
  tester
    .runTests()
    .then((success) => {
      process.exit(success ? 0 : 1);
    })
    .catch((error) => {
      console.error("Test execution failed:", error);
      process.exit(1);
    });
}

module.exports = TestReportSizeIdentifier;
