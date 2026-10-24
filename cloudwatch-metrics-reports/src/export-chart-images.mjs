/**
 * Export individual chart images from the HTML report
 * Captures each chart as a separate PNG for Confluence embedding
 */

import puppeteer from "puppeteer";
import { resolve } from "path";
import { existsSync, mkdirSync } from "fs";

const htmlFile = resolve("./output/consumer-apps-observability-report.html");
const outputDir = resolve("./output/charts");

async function main() {
  if (!existsSync(htmlFile)) {
    console.error("❌ HTML report not found. Run 'npm run html-report' first.");
    process.exit(1);
  }

  mkdirSync(outputDir, { recursive: true });

  console.log("🚀 Launching browser...");
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });

  console.log("📄 Loading HTML report...");
  await page.goto(`file://${htmlFile}`, { waitUntil: "networkidle0", timeout: 30000 });

  // Wait for charts to render
  await new Promise((r) => setTimeout(r, 3000));

  // Capture each chart section
  const charts = [
    { id: "trafficChart", name: "api-traffic-trend" },
    { id: "errorChart", name: "5xx-error-rate-trend" },
    { id: "cpuChart", name: "cpu-utilization-trend" },
    { id: "memChart", name: "memory-utilization-trend" },
    { id: "latencyChart", name: "latency-p90-trend" },
    { id: "portalLatencyChart", name: "portal-latency-comparison" },
    { id: "portal5xxChart", name: "portal-5xx-comparison" },
    { id: "portalTrafficChart", name: "portal-traffic-comparison" },
    { id: "portalLCPChart", name: "portal-lcp-comparison" },
  ];

  for (const chart of charts) {
    const element = await page.$(`#${chart.id}`);
    if (element) {
      // Get the parent .card element for better framing
      const card = await page.evaluateHandle((id) => {
        const canvas = document.getElementById(id);
        return canvas.closest(".card") || canvas;
      }, chart.id);

      const filePath = resolve(outputDir, `${chart.name}.png`);
      await card.asElement().screenshot({ path: filePath, type: "png" });
      console.log(`  ✅ ${chart.name}.png`);
    } else {
      console.log(`  ⚠️ ${chart.id} not found, skipping`);
    }
  }

  // Also capture the full summary table
  const summaryTable = await page.$("table:last-of-type");
  if (summaryTable) {
    await summaryTable.screenshot({ path: resolve(outputDir, "summary-table.png"), type: "png" });
    console.log("  ✅ summary-table.png");
  }

  await browser.close();
  console.log(`\n✅ Chart images saved to: ${outputDir}/`);
}

main().catch((e) => {
  console.error("❌ Error:", e.message);
  process.exit(1);
});
