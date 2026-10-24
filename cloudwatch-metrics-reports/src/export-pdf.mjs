/**
 * Export the HTML observability report to PDF
 * Uses Puppeteer to render Chart.js and capture as high-quality PDF
 */

import puppeteer from "puppeteer";
import { resolve } from "path";
import { existsSync, statSync } from "fs";

const htmlFile = resolve("./output/consumer-apps-observability-report.html");
const pdfFile = resolve("./output/consumer-apps-observability-report.pdf");

async function main() {
  if (!existsSync(htmlFile)) {
    console.error("❌ HTML report not found. Run 'npm run html-report' first.");
    process.exit(1);
  }

  console.log("🚀 Launching browser...");
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  // Set viewport for consistent rendering
  await page.setViewport({ width: 1200, height: 800 });

  console.log("📄 Loading HTML report...");
  await page.goto(`file://${htmlFile}`, {
    waitUntil: "networkidle0",
    timeout: 30000,
  });

  // Wait for Chart.js to finish rendering
  await page.waitForFunction(() => {
    const canvases = document.querySelectorAll("canvas");
    return canvases.length > 0;
  });
  // Extra time for animations to complete
  await new Promise((r) => setTimeout(r, 2000));

  console.log("📊 Generating PDF...");
  await page.pdf({
    path: pdfFile,
    format: "A3",
    printBackground: true,
    margin: { top: "20px", right: "20px", bottom: "20px", left: "20px" },
    preferCSSPageSize: false,
  });

  await browser.close();

  console.log(`\n✅ PDF exported: ${pdfFile}`);
  console.log(`   File size: ${(statSync(pdfFile).size / 1024).toFixed(0)} KB`);
  console.log(`\n📧 You can now attach this PDF to your email.`);
}

main().catch((e) => {
  console.error("❌ Error:", e.message);
  process.exit(1);
});
