const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const csv = require("csv-parser");
const createCsvWriter = require("csv-writer").createObjectCsvWriter;
require("dotenv").config();

class PDFCompressor {
  constructor() {
    console.log("🚀 Initializing PDF Compressor...");

    // Initialize AWS clients with profile
    const awsConfig = {
      region: process.env.AWS_REGION,
      profile: process.env.AWS_PROFILE,
    };

    console.log(`📍 AWS Region: ${process.env.AWS_REGION}`);
    console.log(`👤 AWS Profile: ${process.env.AWS_PROFILE}`);

    this.s3Client = new S3Client(awsConfig);
    console.log("✅ AWS S3 client initialized successfully");

    // Configuration
    this.config = {
      inputCsvFile: process.env.INPUT_CSV_FILE || "large_documents_report.csv",
      outputCsvFile:
        process.env.OUTPUT_CSV_FILE || "compressed_documents_report.csv",
      tempDir: process.env.TEMP_DIR || "./temp",
      maxConcurrency: parseInt(process.env.MAX_CONCURRENCY) || 3,
      delayBetweenFiles: parseInt(process.env.DELAY_BETWEEN_FILES_MS) || 1000,
    };

    console.log("📋 Configuration loaded:");
    console.log(`   📄 Input CSV: ${this.config.inputCsvFile}`);
    console.log(`   📄 Output CSV: ${this.config.outputCsvFile}`);
    console.log(`   📁 Temp directory: ${this.config.tempDir}`);
    console.log(`   🔄 Max concurrency: ${this.config.maxConcurrency}`);

    // Ensure temp directory exists
    if (!fs.existsSync(this.config.tempDir)) {
      fs.mkdirSync(this.config.tempDir, { recursive: true });
      console.log(`📁 Created temp directory: ${this.config.tempDir}`);
    }

    // Track processing statistics
    this.stats = {
      totalFiles: 0,
      processedFiles: 0,
      successfulCompressions: 0,
      failedCompressions: 0,
      totalOriginalSize: 0,
      totalCompressedSize: 0,
      errors: [],
    };

    // Initialize CSV writer for incremental updates
    this.initializeCsvWriter();
  }

  initializeCsvWriter() {
    this.csvWriter = createCsvWriter({
      path: this.config.outputCsvFile,
      header: [
        { id: "caseId", title: "Case ID" },
        { id: "verificationRequestId", title: "Verification Request ID" },
        { id: "reportId", title: "Report ID" },
        { id: "documentId", title: "Document ID" },
        { id: "originalS3Uri", title: "Original S3 URI" },
        { id: "originalSizeMB", title: "Original Size (MB)" },
        { id: "backupS3Uri", title: "Backup S3 URI" },
        { id: "compressedS3Uri", title: "Compressed S3 URI" },
        { id: "compressedSizeMB", title: "Compressed Size (MB)" },
        { id: "compressionRatio", title: "Compression Ratio (%)" },
        { id: "status", title: "Status" },
        { id: "errorMessage", title: "Error Message" },
        { id: "processedAt", title: "Processed At" },
      ],
      append: false, // Will be set to true after first write
    });
  }

  async readCsvFile() {
    return new Promise((resolve, reject) => {
      const results = [];

      console.log(`📖 Reading CSV file: ${this.config.inputCsvFile}`);

      fs.createReadStream(this.config.inputCsvFile)
        .pipe(csv())
        .on("data", (data) => {
          // Convert CSV data to our expected format
          const record = {
            caseId: data["Case ID"] || "N/A",
            verificationRequestId: data["Verification Request ID"],
            reportId: data["Report ID"],
            documentId: data["Document ID"],
            originalS3Uri: data["S3 URI"],
            originalSizeMB: parseFloat(data["Document Size (MB)"]),
            backupS3Uri: "",
            compressedS3Uri: "",
            compressedSizeMB: 0,
            compressionRatio: 0,
            status: "pending",
            errorMessage: "",
            processedAt: "",
          };
          results.push(record);
        })
        .on("end", () => {
          console.log(
            `✅ Successfully read ${results.length} records from CSV`
          );
          this.stats.totalFiles = results.length;
          resolve(results);
        })
        .on("error", (error) => {
          console.error("❌ Error reading CSV file:", error);
          reject(error);
        });
    });
  }

  parseS3Uri(s3Uri) {
    // Parse s3://bucket-name/key/path
    const match = s3Uri.match(/^s3:\/\/([^\/]+)\/(.+)$/);
    if (!match) {
      throw new Error(`Invalid S3 URI format: ${s3Uri}`);
    }
    return {
      bucket: match[1],
      key: match[2],
    };
  }

  async downloadFromS3(bucket, key, localPath) {
    try {
      console.log(`⬇️  Downloading from S3: s3://${bucket}/${key}`);

      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      const response = await this.s3Client.send(command);
      const chunks = [];

      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }

      const buffer = Buffer.concat(chunks);
      fs.writeFileSync(localPath, buffer);

      console.log(
        `✅ Downloaded file to: ${localPath} (${(
          buffer.length /
          1024 /
          1024
        ).toFixed(2)} MB)`
      );
      return buffer.length;
    } catch (error) {
      console.error(`❌ Error downloading from S3: ${error.message}`);
      throw error;
    }
  }

  async compressPdf(inputPath, outputPath) {
    try {
      console.log(`🗜️  Compressing PDF: ${inputPath} -> ${outputPath}`);

      const gsCommand = `gs -q -dNOPAUSE -dBATCH -dSAFER -dSimulateOverprint=true -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dEmbedAllFonts=true -dSubsetFonts=true -dAutoRotatePages=/None -dColorImageDownsampleType=/Bicubic -dColorImageResolution=100 -dGrayImageDownsampleType=/Bicubic -dGrayImageResolution=100 -dMonoImageDownsampleType=/Bicubic -dMonoImageResolution=100 -sOutputFile="${outputPath}" "${inputPath}"`;

      execSync(gsCommand, { stdio: "pipe" });

      const compressedSize = fs.statSync(outputPath).size;
      console.log(
        `✅ PDF compressed successfully (${(
          compressedSize /
          1024 /
          1024
        ).toFixed(2)} MB)`
      );

      return compressedSize;
    } catch (error) {
      console.error(`❌ Error compressing PDF: ${error.message}`);
      throw error;
    }
  }

  async uploadToS3(localPath, bucket, key) {
    try {
      console.log(`⬆️  Uploading to S3: s3://${bucket}/${key}`);

      const fileContent = fs.readFileSync(localPath);

      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: fileContent,
        ContentType: "application/pdf",
      });

      await this.s3Client.send(command);
      console.log(`✅ Uploaded successfully to S3: s3://${bucket}/${key}`);

      return fileContent.length;
    } catch (error) {
      console.error(`❌ Error uploading to S3: ${error.message}`);
      throw error;
    }
  }

  async createBackupInS3(bucket, originalKey) {
    try {
      const backupKey = this.generateBackupKey(originalKey);
      console.log(`💾 Creating backup: s3://${bucket}/${backupKey}`);

      const command = new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${originalKey}`,
        Key: backupKey,
      });

      await this.s3Client.send(command);
      console.log(`✅ Backup created successfully`);

      return `s3://${bucket}/${backupKey}`;
    } catch (error) {
      console.error(`❌ Error creating backup: ${error.message}`);
      throw error;
    }
  }

  generateBackupKey(originalKey) {
    const pathParts = originalKey.split("/");
    const fileName = pathParts[pathParts.length - 1];
    const fileNameParts = fileName.split(".");

    if (fileNameParts.length > 1) {
      // Insert _backup before the file extension
      fileNameParts[fileNameParts.length - 2] += "_backup";
      pathParts[pathParts.length - 1] = fileNameParts.join(".");
    } else {
      // No extension, just append _backup
      pathParts[pathParts.length - 1] += "_backup";
    }

    return pathParts.join("/");
  }

  async getS3ObjectSize(bucket, key) {
    try {
      const command = new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      const response = await this.s3Client.send(command);
      return response.ContentLength;
    } catch (error) {
      console.error(`❌ Error getting S3 object size: ${error.message}`);
      throw error;
    }
  }

  async updateCsvRecord(record) {
    try {
      // For incremental updates, we'll append to the CSV
      this.csvWriter.path = this.config.outputCsvFile;
      this.csvWriter.append = this.stats.processedFiles > 0;

      await this.csvWriter.writeRecords([record]);
      console.log(
        `📝 Updated CSV record for Document ID: ${record.documentId}`
      );
    } catch (error) {
      console.error(`❌ Error updating CSV record: ${error.message}`);
    }
  }

  async processRecord(record) {
    const startTime = Date.now();
    console.log(`\n🔄 Processing Document ID: ${record.documentId}`);
    console.log(
      `📊 Progress: ${this.stats.processedFiles + 1}/${this.stats.totalFiles}`
    );

    try {
      // Parse S3 URI
      const { bucket, key } = this.parseS3Uri(record.originalS3Uri);

      // Generate local file paths
      const originalFileName = path.basename(key);
      const tempOriginalPath = path.join(
        this.config.tempDir,
        `original_${Date.now()}_${originalFileName}`
      );
      const tempCompressedPath = path.join(
        this.config.tempDir,
        `compressed_${Date.now()}_${originalFileName}`
      );

      try {
        // Step 1: Download original file from S3
        await this.downloadFromS3(bucket, key, tempOriginalPath);

        // Step 2: Compress the PDF
        const compressedSize = await this.compressPdf(
          tempOriginalPath,
          tempCompressedPath
        );

        // Step 3: Create backup in S3
        const backupS3Uri = await this.createBackupInS3(bucket, key);

        // Step 4: Upload compressed file to replace original
        await this.uploadToS3(tempCompressedPath, bucket, key);

        // Step 5: Get final compressed size from S3
        const finalCompressedSize = await this.getS3ObjectSize(bucket, key);

        // Calculate compression ratio
        const originalSizeBytes = record.originalSizeMB * 1024 * 1024;
        const compressionRatio =
          ((originalSizeBytes - finalCompressedSize) / originalSizeBytes) * 100;

        // Update record with success data
        record.backupS3Uri = backupS3Uri;
        record.compressedS3Uri = record.originalS3Uri; // Same URI, but now compressed
        record.compressedSizeMB = parseFloat(
          (finalCompressedSize / 1024 / 1024).toFixed(2)
        );
        record.compressionRatio = parseFloat(compressionRatio.toFixed(2));
        record.status = "success";
        record.processedAt = new Date().toISOString();

        // Update statistics
        this.stats.successfulCompressions++;
        this.stats.totalOriginalSize += originalSizeBytes;
        this.stats.totalCompressedSize += finalCompressedSize;

        console.log(`✅ Successfully processed document`);
        console.log(
          `   📉 Size reduction: ${record.originalSizeMB} MB -> ${record.compressedSizeMB} MB (${record.compressionRatio}% reduction)`
        );
      } finally {
        // Clean up temporary files
        [tempOriginalPath, tempCompressedPath].forEach((filePath) => {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`🗑️  Cleaned up temp file: ${filePath}`);
          }
        });
      }
    } catch (error) {
      console.error(`❌ Error processing record: ${error.message}`);

      // Update record with error data
      record.status = "failed";
      record.errorMessage = error.message;
      record.processedAt = new Date().toISOString();

      this.stats.failedCompressions++;
      this.stats.errors.push({
        documentId: record.documentId,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }

    // Update CSV with current record (success or failure)
    await this.updateCsvRecord(record);

    this.stats.processedFiles++;
    const processingTime = Date.now() - startTime;
    console.log(`⏱️  Processing time: ${(processingTime / 1000).toFixed(2)}s`);

    // Add delay between files to prevent overwhelming S3
    if (this.config.delayBetweenFiles > 0) {
      console.log(
        `⏳ Waiting ${this.config.delayBetweenFiles}ms before next file...`
      );
      await new Promise((resolve) =>
        setTimeout(resolve, this.config.delayBetweenFiles)
      );
    }
  }

  async processAllRecords(records) {
    console.log(`\n🚀 Starting to process ${records.length} PDF files...`);

    // Process files with limited concurrency
    const chunks = [];
    for (let i = 0; i < records.length; i += this.config.maxConcurrency) {
      chunks.push(records.slice(i, i + this.config.maxConcurrency));
    }

    for (const chunk of chunks) {
      console.log(`\n📦 Processing batch of ${chunk.length} files...`);
      await Promise.all(chunk.map((record) => this.processRecord(record)));
    }
  }

  printFinalStatistics() {
    console.log("\n" + "=".repeat(60));
    console.log("📊 FINAL PROCESSING STATISTICS");
    console.log("=".repeat(60));
    console.log(`📄 Total files processed: ${this.stats.processedFiles}`);
    console.log(
      `✅ Successful compressions: ${this.stats.successfulCompressions}`
    );
    console.log(`❌ Failed compressions: ${this.stats.failedCompressions}`);

    if (this.stats.successfulCompressions > 0) {
      const totalReductionMB =
        (this.stats.totalOriginalSize - this.stats.totalCompressedSize) /
        1024 /
        1024;
      const avgCompressionRatio =
        ((this.stats.totalOriginalSize - this.stats.totalCompressedSize) /
          this.stats.totalOriginalSize) *
        100;

      console.log(`📉 Total size reduction: ${totalReductionMB.toFixed(2)} MB`);
      console.log(
        `📊 Average compression ratio: ${avgCompressionRatio.toFixed(2)}%`
      );
      console.log(
        `💾 Original total size: ${(
          this.stats.totalOriginalSize /
          1024 /
          1024
        ).toFixed(2)} MB`
      );
      console.log(
        `💾 Compressed total size: ${(
          this.stats.totalCompressedSize /
          1024 /
          1024
        ).toFixed(2)} MB`
      );
    }

    console.log(`📝 Output CSV file: ${this.config.outputCsvFile}`);

    if (this.stats.errors.length > 0) {
      console.log("\n❌ ERRORS ENCOUNTERED:");
      this.stats.errors.forEach((error, index) => {
        console.log(
          `${index + 1}. Document ${error.documentId}: ${error.error}`
        );
      });
    }

    console.log("=".repeat(60));
  }

  async run() {
    try {
      console.log("🎯 Starting PDF Compression Process...");

      // Check if Ghostscript is available
      try {
        execSync("gs --version", { stdio: "pipe" });
        console.log("✅ Ghostscript is available");
      } catch (error) {
        throw new Error(
          "Ghostscript (gs) is not installed or not available in PATH. Please install Ghostscript first."
        );
      }

      // Read CSV file
      const records = await this.readCsvFile();

      if (records.length === 0) {
        console.log("⚠️  No records found in CSV file. Exiting...");
        return;
      }

      // Process all records
      await this.processAllRecords(records);

      // Print final statistics
      this.printFinalStatistics();

      console.log("🎉 PDF compression process completed successfully!");
    } catch (error) {
      console.error(
        "💥 Fatal error during PDF compression process:",
        error.message
      );
      process.exit(1);
    }
  }
}

// Main execution
if (require.main === module) {
  const compressor = new PDFCompressor();
  compressor.run().catch((error) => {
    console.error("💥 Unhandled error:", error);
    process.exit(1);
  });
}

module.exports = PDFCompressor;
