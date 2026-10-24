/**
 * Publish the observability report to Confluence
 * Uploads PDF + chart images and updates page content
 *
 * Usage: node src/publish-to-confluence.mjs
 *
 * Requires env vars (or uses defaults from team setup):
 *   CONFLUENCE_URL       - e.g., https://dataflowplus.atlassian.net/wiki
 *   CONFLUENCE_USERNAME  - e.g., alokraj@dataflowgroup.com
 *   CONFLUENCE_API_TOKEN - Atlassian API token
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve, basename } from "path";

const CONFLUENCE_URL = process.env.CONFLUENCE_URL || "https://dataflowplus.atlassian.net/wiki";
const USERNAME = process.env.CONFLUENCE_USERNAME || process.env.JIRA_USERNAME;
const API_TOKEN = process.env.CONFLUENCE_API_TOKEN || process.env.JIRA_API_TOKEN;
const PAGE_ID = "4929814537"; // Trend Analysis - 12 Weeks

const outputDir = resolve("./output");
const chartsDir = resolve("./output/charts");
const pdfFile = resolve("./output/consumer-apps-observability-report.pdf");
const markdownFile = resolve("./output/consumer-apps-traffic-trend-report.md");

function getAuthHeader() {
  const encoded = Buffer.from(`${USERNAME}:${API_TOKEN}`).toString("base64");
  return `Basic ${encoded}`;
}

async function getPageVersion() {
  const resp = await fetch(`${CONFLUENCE_URL}/rest/api/content/${PAGE_ID}?expand=version`, {
    headers: { Authorization: getAuthHeader(), Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`Failed to get page: ${resp.status}`);
  const data = await resp.json();
  return data.version.number;
}

async function uploadAttachment(filePath) {
  const fileName = basename(filePath);
  const fileBuffer = readFileSync(filePath);

  const formData = new FormData();
  formData.append("file", new Blob([fileBuffer]), fileName);
  formData.append("minorEdit", "true");
  formData.append("comment", `Weekly report upload - ${new Date().toISOString().slice(0, 10)}`);

  const resp = await fetch(
    `${CONFLUENCE_URL}/rest/api/content/${PAGE_ID}/child/attachment`,
    {
      method: "PUT",
      headers: {
        Authorization: getAuthHeader(),
        "X-Atlassian-Token": "nocheck",
      },
      body: formData,
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`  ❌ Failed to upload ${fileName}: ${resp.status} - ${text}`);
    return false;
  }

  console.log(`  ✅ ${fileName}`);
  return true;
}

async function updatePageContent(markdownContent) {
  const currentVersion = await getPageVersion();

  // Build storage format with embedded images
  let body = markdownToConfluenceStorage(markdownContent);

  const payload = {
    version: { number: currentVersion + 1, message: `Weekly report update - ${new Date().toISOString().slice(0, 10)}` },
    title: "Trend Analysis - 12 Weeks",
    type: "page",
    body: {
      storage: {
        value: body,
        representation: "storage",
      },
    },
  };

  const resp = await fetch(`${CONFLUENCE_URL}/rest/api/content/${PAGE_ID}`, {
    method: "PUT",
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to update page: ${resp.status} - ${text}`);
  }

  return true;
}

function markdownToConfluenceStorage(md) {
  // Simple markdown to Confluence storage format conversion
  let html = md;

  // Headers
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Italic
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Horizontal rules
  html = html.replace(/^---$/gm, "<hr/>");

  // Tables
  html = html.replace(/\|---.*\|/g, ""); // Remove separator rows
  html = html.replace(/^\|(.+)\|$/gm, (match, content) => {
    const cells = content.split("|").map((c) => c.trim());
    const row = cells.map((c) => `<td>${c}</td>`).join("");
    return `<tr>${row}</tr>`;
  });

  // Wrap table rows
  html = html.replace(/((?:<tr>.*<\/tr>\n?)+)/g, "<table><tbody>$1</tbody></table>");

  // Line breaks for remaining lines
  html = html.replace(/\n\n/g, "</p><p>");
  html = html.replace(/\n/g, "<br/>");

  // Add chart images at the bottom
  html += `
<h2>📊 Visual Trend Charts</h2>
<h3>API Traffic &amp; Error Rate</h3>
<p><ac:image ac:width="600"><ri:attachment ri:filename="api-traffic-trend.png"/></ac:image></p>
<p><ac:image ac:width="600"><ri:attachment ri:filename="5xx-error-rate-trend.png"/></ac:image></p>
<h3>Infrastructure — CPU &amp; Memory</h3>
<p><ac:image ac:width="600"><ri:attachment ri:filename="cpu-utilization-trend.png"/></ac:image></p>
<p><ac:image ac:width="600"><ri:attachment ri:filename="memory-utilization-trend.png"/></ac:image></p>
<h3>API Latency (p90)</h3>
<p><ac:image ac:width="600"><ri:attachment ri:filename="latency-p90-trend.png"/></ac:image></p>
<h3>Portal Comparisons</h3>
<p><ac:image ac:width="600"><ri:attachment ri:filename="portal-latency-comparison.png"/></ac:image></p>
<p><ac:image ac:width="600"><ri:attachment ri:filename="portal-5xx-comparison.png"/></ac:image></p>
<p><ac:image ac:width="600"><ri:attachment ri:filename="portal-traffic-comparison.png"/></ac:image></p>
<p><ac:image ac:width="600"><ri:attachment ri:filename="portal-lcp-comparison.png"/></ac:image></p>
`;

  return html;
}

async function main() {
  console.log("");
  console.log("📤 Publishing to Confluence...");
  console.log(`   Page: Trend Analysis - 12 Weeks (ID: ${PAGE_ID})`);
  console.log("");

  if (!USERNAME || !API_TOKEN) {
    console.error("❌ Missing credentials. Set CONFLUENCE_USERNAME and CONFLUENCE_API_TOKEN env vars.");
    console.error("   Or set JIRA_USERNAME and JIRA_API_TOKEN (same token works for both).");
    process.exit(1);
  }

  // Check files exist
  if (!existsSync(pdfFile)) {
    console.error("❌ PDF not found. Run ./generate-weekly-report.sh first.");
    process.exit(1);
  }

  if (!existsSync(chartsDir)) {
    console.error("❌ Charts not found. Run ./generate-weekly-report.sh first.");
    process.exit(1);
  }

  // Step 1: Upload PDF
  console.log("📎 Uploading attachments...");
  await uploadAttachment(pdfFile);

  // Step 2: Upload chart images
  const chartFiles = readdirSync(chartsDir).filter((f) => f.endsWith(".png"));
  for (const file of chartFiles) {
    await uploadAttachment(resolve(chartsDir, file));
  }

  // Step 3: Update page content (if markdown report exists)
  if (existsSync(markdownFile)) {
    console.log("");
    console.log("📝 Updating page content...");
    const md = readFileSync(markdownFile, "utf8");
    await updatePageContent(md);
    console.log("  ✅ Page content updated with charts embedded");
  }

  console.log("");
  console.log("✅ Published successfully!");
  console.log(`   📄 https://dataflowplus.atlassian.net/wiki/spaces/DEE/pages/${PAGE_ID}`);
  console.log("");
}

main().catch((e) => {
  console.error("❌ Error:", e.message);
  process.exit(1);
});
