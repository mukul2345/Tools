const { DynamoDBClient, QueryCommand } = require("@aws-sdk/client-dynamodb");
const { S3Client, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const createCsvWriter = require("csv-writer").createObjectCsvWriter;
const fs = require("fs");
const path = require("path");
require("dotenv").config();

class ReportSizeIdentifier {
  constructor() {
    console.log("🚀 Initializing Report Size Identifier...");

    // Initialize AWS clients with profile
    const awsConfig = {
      region: process.env.AWS_REGION,
      profile: process.env.AWS_PROFILE,
    };

    console.log(`📍 AWS Region: ${process.env.AWS_REGION}`);
    console.log(`👤 AWS Profile: ${process.env.AWS_PROFILE}`);

    this.dynamoClient = new DynamoDBClient(awsConfig);
    this.s3Client = new S3Client(awsConfig);
    console.log("✅ AWS clients initialized successfully");

    // Configuration
    this.config = {
      verificationRequestTable: process.env.VERIFICATION_REQUEST_TABLE,
      reportTable: process.env.REPORT_TABLE,
      documentTable: process.env.DOCUMENT_TABLE,
      workflowTable: process.env.WORKFLOW_TABLE,
      s3BucketName: process.env.S3_BUCKET_NAME,
      maxFileSizeMB: parseFloat(process.env.MAX_FILE_SIZE_MB),
      outputCsvFile: process.env.OUTPUT_CSV_FILE,
      clientId: process.env.CLIENT_ID,
      // Concurrency control settings
      maxConcurrency: parseInt(process.env.MAX_CONCURRENCY) || 5,
      batchSize: parseInt(process.env.BATCH_SIZE) || 20,
      delayBetweenBatches:
        parseInt(process.env.DELAY_BETWEEN_BATCHES_MS) || 1000,
    };

    console.log("📋 Configuration loaded:");
    console.log(`   📊 Client ID: ${this.config.clientId}`);
    console.log(`   📏 Max file size: ${this.config.maxFileSizeMB}MB`);
    console.log(`   🪣 S3 Bucket: ${this.config.s3BucketName}`);
    console.log(`   📝 Output file: ${this.config.outputCsvFile}`);
    console.log(`   🔄 Max concurrency: ${this.config.maxConcurrency}`);
    console.log(`   📦 Batch size: ${this.config.batchSize}`);
    console.log(
      `   ⏱️ Delay between batches: ${this.config.delayBetweenBatches}ms`
    );

    this.results = [];
    this.processedCount = 0;
    this.errorCount = 0;
    this.lastResultCount = 0;
    this.startTime = Date.now();
  }

  /**
   * Query DynamoDB table with pagination support
   */
  async queryDynamoDB(
    tableName,
    keyConditionExpression,
    expressionAttributeValues,
    filterExpression = null,
    indexName = null
  ) {
    console.log(
      `🔍 Querying table: ${tableName}${
        indexName ? ` (Index: ${indexName})` : ""
      }`
    );
    const items = [];
    let lastEvaluatedKey = null;
    let pageCount = 0;

    do {
      pageCount++;
      const params = {
        TableName: tableName,
        KeyConditionExpression: keyConditionExpression,
        ExpressionAttributeValues: expressionAttributeValues,
        ...(filterExpression && { FilterExpression: filterExpression }),
        ...(indexName && { IndexName: indexName }),
        ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey }),
      };

      try {
        const command = new QueryCommand(params);
        const response = await this.dynamoClient.send(command);

        if (response.Items) {
          const pageItems = response.Items.map((item) => unmarshall(item));
          items.push(...pageItems);
          console.log(
            `   📄 Page ${pageCount}: ${pageItems.length} items (Total: ${items.length})`
          );
        }

        lastEvaluatedKey = response.LastEvaluatedKey;
      } catch (error) {
        console.error(`❌ Error querying ${tableName}:`, error);
        throw error;
      }
    } while (lastEvaluatedKey);

    console.log(`✅ Query completed. Total items: ${items.length}`);
    return items;
  }

  /**
   * Step 1: Query VerificationRequest table with clientId and filter on reportId exists
   */
  async getVerificationRequests() {
    console.log("\n📋 STEP 1: Querying VerificationRequest table...");
    console.log(`🔍 Client ID: ${this.config.clientId}`);
    console.log(`🎯 Filter: reportId exists AND non-legacy records`);

    const verificationRequests = await this.queryDynamoDB(
      this.config.verificationRequestTable,
      "clientId = :clientId",
      {
        ":clientId": { S: this.config.clientId },
        ":legacyValue": { BOOL: true },
      },
      "attribute_exists(reportId) AND (attribute_not_exists(legacy) OR legacy <> :legacyValue)",
      "clientId-index" // Assuming GSI exists on clientId
    );

    console.log(
      `✅ Found ${verificationRequests.length} verification requests matching criteria`
    );
    return verificationRequests;
  }

  /**
   * Step 2: Get Report entity by querying Report table with reportId
   */
  async getReport(reportId) {
    console.log(`📊 STEP 2: Getting Report for reportId: ${reportId}`);

    const reports = await this.queryDynamoDB(
      this.config.reportTable,
      "id = :reportId",
      {
        ":reportId": { S: reportId },
      }
    );

    const report = reports.length > 0 ? reports[0] : null;
    if (report) {
      console.log(`✅ Report found for ID: ${reportId}`);
    } else {
      console.log(`⚠️ No report found for ID: ${reportId}`);
    }

    return report;
  }

  /**
   * Step 3: Extract client report document id from report.reportTypeAndIdMap.CLIENT
   */
  extractClientDocumentId(report) {
    console.log(`📄 STEP 3: Extracting client document ID from report`);

    if (
      report &&
      report.reportTypeAndIdMap &&
      report.reportTypeAndIdMap.CLIENT
    ) {
      const documentId = report.reportTypeAndIdMap.CLIENT;
      console.log(`✅ Client document ID found: ${documentId}`);
      return documentId;
    }

    console.log(`⚠️ No client document ID found in report structure`);
    return null;
  }

  /**
   * Step 4: Get Document entity by querying Document table
   */
  async getDocument(documentId) {
    console.log(`📋 STEP 4: Getting Document for documentId: ${documentId}`);

    const documents = await this.queryDynamoDB(
      this.config.documentTable,
      "id = :documentId",
      {
        ":documentId": { S: documentId },
      }
    );

    const document = documents.length > 0 ? documents[0] : null;
    if (document) {
      console.log(`✅ Document found: ${documentId}`);
      console.log(`   📁 Owner: ${document.owner || "N/A"}`);
      console.log(`   📎 File URI: ${document.fileUri || "N/A"}`);
    } else {
      console.log(`⚠️ No document found for ID: ${documentId}`);
    }

    return document;
  }

  /**
   * Step 5: Build S3 URL from document entity
   */
  buildS3Url(document) {
    console.log(`🔗 STEP 5: Building S3 URL from document`);

    if (!document || !document.owner || !document.fileUri) {
      console.log(
        `⚠️ Missing required fields - Owner: ${!!document?.owner}, FileURI: ${!!document?.fileUri}`
      );
      return null;
    }

    // Extract UUID from owner (format: User@<uuid>)
    const ownerMatch = document.owner.match(/User@(.+)/);
    if (!ownerMatch) {
      console.warn(`❌ Invalid owner format: ${document.owner}`);
      return null;
    }

    const prefix = ownerMatch[1];
    const fileKey = document.fileUri;
    const s3Url = `s3://${this.config.s3BucketName}/${prefix}/${fileKey}`;

    console.log(`✅ S3 URL constructed: ${s3Url}`);
    console.log(`   🪣 Bucket: ${this.config.s3BucketName}`);
    console.log(`   📂 Prefix: ${prefix}`);
    console.log(`   🔑 Key: ${fileKey}`);

    return {
      bucket: this.config.s3BucketName,
      key: `${prefix}/${fileKey}`,
      url: s3Url,
    };
  }

  /**
   * Step 6: Perform S3 head operation to get content length
   */
  async getS3ObjectSize(s3Info) {
    console.log(`📏 STEP 6: Getting S3 object size for: ${s3Info?.url}`);

    if (!s3Info) {
      console.log(`⚠️ No S3 info provided`);
      return null;
    }

    try {
      const command = new HeadObjectCommand({
        Bucket: s3Info.bucket,
        Key: s3Info.key,
      });

      const response = await this.s3Client.send(command);
      const sizeBytes = response.ContentLength;
      const sizeMB = this.bytesToMB(sizeBytes);

      console.log(
        `✅ Object size retrieved: ${sizeBytes} bytes (${sizeMB.toFixed(2)} MB)`
      );
      return sizeBytes;
    } catch (error) {
      console.error(
        `❌ Error getting S3 object size for ${s3Info.url}:`,
        error.message
      );
      return null;
    }
  }

  /**
   * Step 9: Get caseId by querying Workflow table with resourceEntityId
   */
  async getCaseId(verificationRequestId) {
    console.log(`🔍 STEP 9: Getting caseId for VR: ${verificationRequestId}`);

    try {
      const workflows = await this.queryDynamoDB(
        this.config.workflowTable,
        "resourceEntityId = :resourceEntityId",
        {
          ":resourceEntityId": { S: verificationRequestId },
        },
        null,
        "resourceEntityId-index" // Assuming GSI exists
      );

      const caseId = workflows.length > 0 ? workflows[0].caseId : null;
      if (caseId) {
        console.log(`✅ Case ID found: ${caseId}`);
      } else {
        console.log(`⚠️ No case ID found for VR: ${verificationRequestId}`);
      }

      return caseId;
    } catch (error) {
      console.error(
        `❌ Error getting caseId for VR ${verificationRequestId}:`,
        error.message
      );
      return null;
    }
  }

  /**
   * Convert bytes to MB
   */
  bytesToMB(bytes) {
    return bytes / (1024 * 1024);
  }

  /**
   * Create batches from an array
   */
  createBatches(array, batchSize) {
    const batches = [];
    for (let i = 0; i < array.length; i += batchSize) {
      batches.push(array.slice(i, i + batchSize));
    }
    return batches;
  }

  /**
   * Process items with controlled concurrency
   */
  async processWithConcurrency(items, processor, maxConcurrency = 5) {
    const results = [];
    const executing = [];

    for (const item of items) {
      const promise = processor(item).then((result) => {
        executing.splice(executing.indexOf(promise), 1);
        return result;
      });

      results.push(promise);
      executing.push(promise);

      if (executing.length >= maxConcurrency) {
        await Promise.race(executing);
      }
    }

    return Promise.all(results);
  }

  /**
   * Process a batch of verification requests in parallel
   */
  async processBatch(batch, batchNumber, totalBatches) {
    console.log(
      `\n🔄 Processing batch ${batchNumber}/${totalBatches} (${batch.length} items)`
    );
    const batchStartTime = Date.now();
    let batchErrors = 0;

    const processor = async (vr) => {
      try {
        const result = await this.processVerificationRequest(vr);
        this.processedCount++;
        return result;
      } catch (error) {
        console.error(`❌ Error in batch processing for VR ${vr.id}:`, error);
        batchErrors++;
        this.errorCount++;
        return null;
      }
    };

    await this.processWithConcurrency(
      batch,
      processor,
      this.config.maxConcurrency
    );

    const batchTime = Date.now() - batchStartTime;
    const avgTimePerItem = (batchTime / batch.length).toFixed(0);
    console.log(
      `✅ Batch ${batchNumber} completed in ${(batchTime / 1000).toFixed(2)}s`
    );
    console.log(
      `📊 Batch stats - Processed: ${batch.length}, Errors: ${batchErrors}, Avg time/item: ${avgTimePerItem}ms`
    );
    console.log(
      `🎯 Large documents in this batch: ${
        this.results.length - (this.lastResultCount || 0)
      }`
    );
    this.lastResultCount = this.results.length;
  }

  /**
   * Process a single verification request
   */
  async processVerificationRequest(vr, globalIndex = null, globalTotal = null) {
    const startTime = Date.now();

    console.log(`\n🔄 Processing VR: ${vr.id}`);
    console.log(`📝 Report ID: ${vr.reportId}`);

    try {
      // Step 2: Get Report
      const report = await this.getReport(vr.reportId);
      if (!report) {
        console.warn(`⚠️ Report not found for reportId: ${vr.reportId}`);
        return null;
      }

      // Step 3: Extract client document ID
      const documentId = this.extractClientDocumentId(report);
      if (!documentId) {
        console.warn(
          `⚠️ Client document ID not found in report: ${vr.reportId}`
        );
        return null;
      }

      // Step 4: Get Document
      const document = await this.getDocument(documentId);
      if (!document) {
        console.warn(`⚠️ Document not found for documentId: ${documentId}`);
        return null;
      }

      // Step 5: Build S3 URL
      const s3Info = this.buildS3Url(document);
      if (!s3Info) {
        console.warn(`⚠️ Could not build S3 URL for document: ${documentId}`);
        return null;
      }

      // Step 6: Get S3 object size
      const contentLength = await this.getS3ObjectSize(s3Info);
      if (contentLength === null) {
        console.warn(`⚠️ Could not get S3 object size for: ${s3Info.url}`);
        return null;
      }

      const sizeInMB = this.bytesToMB(contentLength);

      // Step 7: Check if size exceeds threshold
      if (sizeInMB > this.config.maxFileSizeMB) {
        console.log(
          `🎯 LARGE DOCUMENT DETECTED! Size: ${sizeInMB.toFixed(2)}MB (>${
            this.config.maxFileSizeMB
          }MB)`
        );

        // Step 9: Get caseId
        const caseId = await this.getCaseId(vr.id);

        const result = {
          caseId: caseId || "N/A",
          verificationRequestId: vr.id,
          reportId: vr.reportId,
          documentId: documentId,
          s3Uri: s3Info.url,
          documentSizeMB: sizeInMB.toFixed(2),
        };

        // Thread-safe result addition
        this.results.push(result);
        console.log(
          `✅ Added to results. Total large documents found: ${this.results.length}`
        );

        return result;
      } else {
        console.log(
          `✅ Document size OK: ${sizeInMB.toFixed(2)}MB (≤${
            this.config.maxFileSizeMB
          }MB)`
        );
      }

      const processingTime = Date.now() - startTime;
      console.log(`⏱️ Processing time: ${processingTime}ms`);

      return null;
    } catch (error) {
      console.error(`❌ Error processing VR ${vr.id}:`, error);
      throw error;
    }
  }

  /**
   * Generate CSV report
   */
  async generateReport() {
    console.log(`\n📊 STEP 8: Generating CSV report...`);

    if (this.results.length === 0) {
      console.log("📝 No large documents found - no report to generate.");
      return;
    }

    console.log(
      `📋 Creating report with ${this.results.length} large documents`
    );

    const csvWriter = createCsvWriter({
      path: this.config.outputCsvFile,
      header: [
        { id: "caseId", title: "Case ID" },
        { id: "verificationRequestId", title: "Verification Request ID" },
        { id: "reportId", title: "Report ID" },
        { id: "documentId", title: "Document ID" },
        { id: "s3Uri", title: "S3 URI" },
        { id: "documentSizeMB", title: "Document Size (MB)" },
      ],
    });

    try {
      await csvWriter.writeRecords(this.results);
      console.log(
        `✅ Report generated successfully: ${this.config.outputCsvFile}`
      );
      console.log(`📊 Total large documents found: ${this.results.length}`);

      // Log summary of findings
      const totalSizeMB = this.results.reduce(
        (sum, result) => sum + parseFloat(result.documentSizeMB),
        0
      );
      console.log(
        `📏 Total size of large documents: ${totalSizeMB.toFixed(2)}MB`
      );
      console.log(
        `📈 Average document size: ${(
          totalSizeMB / this.results.length
        ).toFixed(2)}MB`
      );
    } catch (error) {
      console.error(`❌ Error generating report:`, error);
      throw error;
    }
  }

  /**
   * Main execution method
   */
  async run() {
    console.log("\n" + "=".repeat(60));
    console.log("🚀 STARTING REPORT SIZE IDENTIFIER (PARALLEL MODE)");
    console.log("=".repeat(60));
    console.log(`📅 Started at: ${new Date().toISOString()}`);

    try {
      // Step 1: Get all verification requests
      const verificationRequests = await this.getVerificationRequests();

      if (verificationRequests.length === 0) {
        console.log(
          "⚠️ No verification requests found with the specified criteria."
        );
        console.log("✅ Script completed - no data to process.");
        return;
      }

      console.log(
        `\n🔄 Processing ${verificationRequests.length} verification requests in parallel...`
      );
      console.log(
        `📦 Batch size: ${this.config.batchSize}, Max concurrency per batch: ${this.config.maxConcurrency}`
      );

      // Create batches for processing
      const batches = this.createBatches(
        verificationRequests,
        this.config.batchSize
      );
      console.log(`📊 Created ${batches.length} batches for processing`);

      // Process batches sequentially, but items within each batch in parallel
      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];

        await this.processBatch(batch, batchIndex + 1, batches.length);

        // Add delay between batches to avoid overwhelming DynamoDB
        if (batchIndex < batches.length - 1) {
          console.log(
            `⏳ Waiting ${this.config.delayBetweenBatches}ms before next batch...`
          );
          await new Promise((resolve) =>
            setTimeout(resolve, this.config.delayBetweenBatches)
          );
        }

        // Overall progress update
        const totalProcessed = (batchIndex + 1) * this.config.batchSize;
        const actualProcessed = Math.min(
          totalProcessed,
          verificationRequests.length
        );
        const progress = (
          (actualProcessed / verificationRequests.length) *
          100
        ).toFixed(1);
        console.log(
          `📊 Overall Progress: ${actualProcessed}/${verificationRequests.length} (${progress}%)`
        );
      }

      // Step 8: Generate report
      await this.generateReport();

      // Final summary
      const totalTime = Date.now() - this.startTime;
      console.log("\n" + "=".repeat(60));
      console.log("\n" + "=".repeat(60));
      console.log("📋 EXECUTION SUMMARY");
      console.log("=".repeat(60));
      console.log(
        `✅ Successfully processed: ${this.processedCount} verification requests`
      );
      console.log(`❌ Errors encountered: ${this.errorCount}`);
      console.log(`🎯 Large documents found: ${this.results.length}`);
      console.log(
        `⏱️ Total execution time: ${(totalTime / 1000).toFixed(2)} seconds`
      );
      console.log(`📅 Completed at: ${new Date().toISOString()}`);
      console.log("=".repeat(60));
    } catch (error) {
      console.error("❌ Fatal error in main execution:", error);
      console.log(
        `💥 Script failed after ${(
          (Date.now() - this.startTime) /
          1000
        ).toFixed(2)} seconds`
      );
      process.exit(1);
    }
  }
}

// Run the script
if (require.main === module) {
  console.log("🎬 Initializing Report Size Identifier Script...");

  const identifier = new ReportSizeIdentifier();
  identifier
    .run()
    .then(() => {
      console.log("\n🎉 Script completed successfully!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("\n💥 Script execution failed:", error);
      process.exit(1);
    });
}

module.exports = ReportSizeIdentifier;
