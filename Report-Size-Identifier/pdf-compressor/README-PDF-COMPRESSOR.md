# PDF Compressor

A Node.js script that reads a CSV file containing S3 URIs of PDF documents, downloads them, compresses them using Ghostscript, creates backups, and replaces the original files with compressed versions.

## Features

- 📄 Reads CSV files with S3 document information
- ⬇️ Downloads PDF files from S3
- 🗜️ Compresses PDFs using Ghostscript with optimized settings
- 💾 Creates backup copies with `_backup` suffix
- ⬆️ Replaces original files with compressed versions
- 📊 Tracks compression statistics and ratios
- 📝 Updates output CSV incrementally after each file
- 🛡️ Comprehensive error handling and logging
- 🔄 Concurrent processing with configurable limits

## Prerequisites

### 1. Ghostscript Installation

The script requires Ghostscript (`gs` command) to be installed and available in your system PATH.

**macOS:**
```bash
brew install ghostscript
```

**Ubuntu/Debian:**
```bash
sudo apt-get install ghostscript
```

**Windows:**
Download and install from: https://www.ghostscript.com/download/gsdnld.html

### 2. Node.js Dependencies

Install the required dependencies:

```bash
npm install
```

### 3. AWS Configuration

Ensure your AWS credentials are configured using AWS CLI profiles:

```bash
aws configure --profile your-profile-name
```

## Configuration

### Environment Variables

Copy the example environment file and configure it:

```bash
cp .env.compressor.example .env
```

Edit `.env` with your specific configuration:

```env
# AWS Configuration
AWS_REGION=us-east-1
AWS_PROFILE=your-aws-profile-name

# Input/Output Configuration
INPUT_CSV_FILE=large_documents_report.csv
OUTPUT_CSV_FILE=compressed_documents_report.csv

# Processing Configuration
TEMP_DIR=./temp
MAX_CONCURRENCY=3
DELAY_BETWEEN_FILES_MS=1000
```

### Configuration Options

| Variable | Description | Default |
|----------|-------------|---------|
| `AWS_REGION` | AWS region for S3 operations | `us-east-1` |
| `AWS_PROFILE` | AWS CLI profile name | Required |
| `INPUT_CSV_FILE` | Path to input CSV file | `large_documents_report.csv` |
| `OUTPUT_CSV_FILE` | Path to output CSV file | `compressed_documents_report.csv` |
| `TEMP_DIR` | Directory for temporary files | `./temp` |
| `MAX_CONCURRENCY` | Number of files to process simultaneously | `3` |
| `DELAY_BETWEEN_FILES_MS` | Delay between processing files (ms) | `1000` |

## Input CSV Format

The input CSV file should have the following columns:

```csv
Case ID,Verification Request ID,Report ID,Document ID,S3 URI,Document Size (MB)
N/A,VerificationRequest@123,Report@456,Document@789,s3://bucket/path/file.pdf,9.22
```

## Output CSV Format

The output CSV includes all original columns plus additional tracking information:

```csv
Case ID,Verification Request ID,Report ID,Document ID,Original S3 URI,Original Size (MB),Backup S3 URI,Compressed S3 URI,Compressed Size (MB),Compression Ratio (%),Status,Error Message,Processed At
```

### Additional Columns

- **Backup S3 URI**: Location of the backup copy with `_backup` suffix
- **Compressed S3 URI**: Location of the compressed file (same as original URI)
- **Compressed Size (MB)**: Size of the compressed file in MB
- **Compression Ratio (%)**: Percentage reduction in file size
- **Status**: `success` or `failed`
- **Error Message**: Error details if processing failed
- **Processed At**: ISO timestamp when processing completed

## Usage

### Basic Usage

```bash
# Run with default configuration
npm run compress

# Or run directly
node pdf-compressor.js
```

### Advanced Usage

```bash
# Use custom environment file
INPUT_CSV_FILE=custom_input.csv OUTPUT_CSV_FILE=custom_output.csv node pdf-compressor.js

# Process with higher concurrency
MAX_CONCURRENCY=5 node pdf-compressor.js
```

## Ghostscript Compression Settings

The script uses optimized Ghostscript settings for PDF compression:

```bash
gs -q -dNOPAUSE -dBATCH -dSAFER -dSimulateOverprint=true \
   -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 \
   -dPDFSETTINGS=/ebook \
   -dEmbedAllFonts=true -dSubsetFonts=true \
   -dAutoRotatePages=/None \
   -dColorImageDownsampleType=/Bicubic -dColorImageResolution=100 \
   -dGrayImageDownsampleType=/Bicubic -dGrayImageResolution=100 \
   -dMonoImageDownsampleType=/Bicubic -dMonoImageResolution=100 \
   -sOutputFile="output.pdf" "input.pdf"
```

### Compression Settings Explained

- `/ebook`: Optimized for screen viewing with good compression
- `100 DPI`: Reduces image resolution for smaller file sizes
- `Bicubic`: High-quality downsampling method
- `EmbedAllFonts=true`: Ensures document display consistency
- `SubsetFonts=true`: Only includes used font characters

## Processing Workflow

1. **📖 Read CSV**: Parse input CSV file to get S3 URIs and metadata
2. **⬇️ Download**: Download original PDF file from S3 to temporary directory
3. **🗜️ Compress**: Use Ghostscript to compress the PDF
4. **💾 Backup**: Create backup copy in S3 with `_backup` suffix
5. **⬆️ Replace**: Upload compressed file to replace original
6. **📝 Update**: Write record to output CSV with compression statistics
7. **🗑️ Cleanup**: Remove temporary files
8. **🔄 Repeat**: Process next file with optional delay

## Error Handling

The script includes comprehensive error handling:

- **File Download Errors**: Network issues, missing files, permissions
- **Compression Errors**: Invalid PDFs, Ghostscript failures
- **Upload Errors**: S3 permissions, network issues
- **General Errors**: Configuration issues, disk space

Failed files are logged with error details and included in the output CSV with `status: "failed"`.

## Monitoring Progress

The script provides detailed logging:

```
🚀 Initializing PDF Compressor...
📍 AWS Region: us-east-1
👤 AWS Profile: my-profile
✅ AWS S3 client initialized successfully
📋 Configuration loaded:
   📄 Input CSV: large_documents_report.csv
   📄 Output CSV: compressed_documents_report.csv
   📁 Temp directory: ./temp
   🔄 Max concurrency: 3

📖 Reading CSV file: large_documents_report.csv
✅ Successfully read 31 records from CSV

🔄 Processing Document ID: Document@213a21ac-e335-4bc5-be42-b14dbb79a686
📊 Progress: 1/31
⬇️  Downloading from S3: s3://documents-bucket/path/file.pdf
✅ Downloaded file to: ./temp/original_1694876543210_file.pdf (9.22 MB)
🗜️  Compressing PDF: ./temp/original_1694876543210_file.pdf -> ./temp/compressed_1694876543210_file.pdf
✅ PDF compressed successfully (3.45 MB)
💾 Creating backup: s3://documents-bucket/path/file_backup.pdf
✅ Backup created successfully
⬆️  Uploading to S3: s3://documents-bucket/path/file.pdf
✅ Uploaded successfully to S3
✅ Successfully processed document
   📉 Size reduction: 9.22 MB -> 3.45 MB (62.58% reduction)
📝 Updated CSV record for Document ID: Document@213a21ac-e335-4bc5-be42-b14dbb79a686
⏱️  Processing time: 12.34s
```

## Final Statistics

At completion, the script displays comprehensive statistics:

```
============================================================
📊 FINAL PROCESSING STATISTICS
============================================================
📄 Total files processed: 31
✅ Successful compressions: 29
❌ Failed compressions: 2
📉 Total size reduction: 156.78 MB
📊 Average compression ratio: 58.32%
💾 Original total size: 268.94 MB
💾 Compressed total size: 112.16 MB
📝 Output CSV file: compressed_documents_report.csv
============================================================
```

## Troubleshooting

### Common Issues

1. **Ghostscript not found**
   ```
   Error: Ghostscript (gs) is not installed or not available in PATH
   ```
   - Install Ghostscript using your system's package manager
   - Ensure `gs` command is available in PATH

2. **AWS credentials not configured**
   ```
   Error: Unable to load credentials from any providers
   ```
   - Configure AWS CLI: `aws configure --profile your-profile`
   - Verify profile name in `.env` file

3. **S3 permission denied**
   ```
   Error: Access Denied
   ```
   - Ensure AWS profile has S3 read/write permissions
   - Verify bucket and key permissions

4. **Invalid PDF files**
   ```
   Error: Ghostscript compression failed
   ```
   - Some files may be corrupted or not valid PDFs
   - Check the error message in output CSV for details

5. **Disk space issues**
   ```
   Error: ENOSPC: no space left on device
   ```
   - Free up disk space in temp directory
   - Process files in smaller batches

### Performance Tuning

- **Reduce concurrency** if experiencing S3 rate limits
- **Increase delay** between files for better S3 stability
- **Use faster storage** for temporary directory
- **Monitor memory usage** with large PDF files

## Security Considerations

- **Temporary files**: Automatically cleaned up after processing
- **AWS credentials**: Uses AWS CLI profiles (no hardcoded credentials)
- **S3 permissions**: Requires read/write access only to specified bucket
- **File validation**: Only processes files with valid S3 URIs

## License

ISC License - see package.json for details.