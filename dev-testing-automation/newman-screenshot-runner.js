const newman = require("newman");
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const locateChrome = require("locate-chrome");

// CLI ARGUMENT PARSING
const args = process.argv.slice(2);

function printUsage() {
  console.log(`
📸 Newman Screenshot Runner
============================

Runs a Postman collection and captures screenshots of each API request/response.

Usage:
  node newman-screenshot-runner.js <collection-path> [options]

Arguments:
  collection-path     Path to the Postman collection JSON file (required)

Options:
  -o, --output <dir>  Output directory for screenshots (default: ./screenshots)
  -h, --help          Show this help message

Examples:
  node newman-screenshot-runner.js ./my-collection.json
  node newman-screenshot-runner.js ./api-tests.json -o ./test-results
  node newman-screenshot-runner.js /absolute/path/to/collection.json --output ./reports
`);
}

function parseArgs(args) {
  const options = {
    collectionPath: null,
    outputDir: "./screenshots/dgs",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    } else if (arg === "-o" || arg === "--output") {
      if (!args[i + 1]) {
        console.error("❌ Error: --output requires a directory path");
        process.exit(1);
      }
      options.outputDir = args[++i];
    } else if (!arg.startsWith("-")) {
      if (!options.collectionPath) {
        options.collectionPath = arg;
      }
    }
  }

  return options;
}

const options = parseArgs(args);

// Validate collection path is provided
if (!options.collectionPath) {
  console.error("❌ Error: Collection path is required\n");
  printUsage();
  process.exit(1);
}

// Resolve to absolute path
const COLLECTION_PATH = path.resolve(options.collectionPath);
const SCREENSHOT_DIR = path.resolve(options.outputDir);

// Validate collection file exists
if (!fs.existsSync(COLLECTION_PATH)) {
  console.error(`❌ Error: Collection file not found: ${COLLECTION_PATH}`);
  process.exit(1);
}

// Ensure screenshot directory exists
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  console.log(`📁 Created output directory: ${SCREENSHOT_DIR}`);
}

// Helper to escape HTML special characters
function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Helper to beautify JSON for readability
function beautifyJson(str) {
  if (!str) return "";
  try {
    const parsed = JSON.parse(str);
    return JSON.stringify(parsed, null, 2);
  } catch {
    // Not valid JSON, return as-is
    return str;
  }
}

console.log(`
🚀 Newman Screenshot Runner
===========================
Collection: ${COLLECTION_PATH}
Output Dir: ${SCREENSHOT_DIR}
`);

// Generate HTML content for a request
function generateHtmlContent(requestData) {
  const {
    requestName,
    method,
    url,
    reqBody,
    resBody,
    statusCode,
    statusClass,
  } = requestData;
  return `
    <html>
        <head>
            <style>
                body { font-family: sans-serif; padding: 20px; background: #f4f4f4; }
                .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); max-width: 800px; margin: auto; }
                h2 { border-bottom: 2px solid #ddd; padding-bottom: 10px; }
                .label { font-weight: bold; color: #555; margin-top: 10px; display: block;}
                .box { background: #eee; padding: 10px; border-radius: 4px; overflow-wrap: break-word; font-family: monospace; white-space: pre-wrap; }
                .status-pass { color: green; }
                .status-fail { color: red; }
            </style>
        </head>
        <body>
            <div class="card">
                <h2>${escapeHtml(requestName)}</h2>
                
                <span class="label">Request:</span>
                <div class="box"><strong>${escapeHtml(
                  method
                )}</strong> ${escapeHtml(url)}</div>

                <span class="label">Request Body:</span>
                <div class="box">${escapeHtml(
                  beautifyJson(reqBody) || "No Body"
                )}</div>

                <span class="label">Response Output (<span class="${statusClass}">${statusCode}</span>):</span>
                <div class="box">${escapeHtml(
                  beautifyJson(resBody) || "No Body"
                )}</div>
            </div>
        </body>
    </html>
    `;
}

// Capture screenshot for a single request
async function captureScreenshot(browser, requestData, index) {
  const { requestName } = requestData;
  const htmlContent = generateHtmlContent(requestData);

  const page = await browser.newPage();
  await page.setContent(htmlContent, { waitUntil: "domcontentloaded" });

  // Adjust viewport to capture the whole card
  const bodyHandle = await page.$("body");
  const { height } = await bodyHandle.boundingBox();
  await page.setViewport({ width: 900, height: Math.ceil(height) + 50 });

  const screenshotPath = path.join(
    SCREENSHOT_DIR,
    `${index}_${requestName}.png`
  );
  await page.screenshot({ path: screenshotPath });
  await page.close();

  console.log(`📸 Screenshot captured: ${index}_${requestName}.png`);
}

(async () => {
  const executablePath =
    (await new Promise((resolve) => locateChrome((arg) => resolve(arg)))) || "";

  // Queue to store request data (collected synchronously during newman run)
  const requestQueue = [];

  // Run newman and collect request data
  await new Promise((resolve, reject) => {
    newman
      .run({
        collection: require(COLLECTION_PATH),
        reporters: "cli",
      })
      .on("request", (error, args) => {
        if (error) {
          console.error("Error running request", error);
          return;
        }

        const requestName = args.item.name.replace(/[^a-z0-9]/gi, "_");
        const url = args.request.url.toString();
        const method = args.request.method;

        // Get Request Body (if raw JSON)
        let reqBody = "";
        if (args.request.body && args.request.body.mode === "raw") {
          reqBody = args.request.body.raw;
        }

        // Get Response Body
        const resBody = args.response.stream.toString();
        const statusCode = args.response.code;
        const statusClass =
          statusCode >= 200 && statusCode < 400 ? "status-pass" : "status-fail";

        // Queue the request data for screenshot capture later
        requestQueue.push({
          requestName,
          method,
          url,
          reqBody,
          resBody,
          statusCode,
          statusClass,
        });
      })
      .on("done", (err, summary) => {
        if (err || summary.error) {
          reject(new Error("Collection run encountered errors"));
        } else {
          resolve();
        }
      });
  });

  console.log(`\n📷 Capturing ${requestQueue.length} screenshots...\n`);

  // Launch Puppeteer after newman completes
  const browser = await puppeteer.launch({
    executablePath,
  });

  // Process all screenshots sequentially
  for (let i = 0; i < requestQueue.length; i++) {
    await captureScreenshot(browser, requestQueue[i], i + 1);
  }

  await browser.close();

  console.log(`
✅ Collection Run Complete
==========================
Total Requests: ${requestQueue.length}
Screenshots saved to: ${SCREENSHOT_DIR}
`);
})();
