#!/bin/bash

# ============================================================
# Consumer Apps & Services — Weekly Observability Report
# ============================================================
# Run this script to generate the full report with charts.
#
# Prerequisites:
#   - Node.js 20+
#   - AWS credentials configured (profile: df-prod)
#   - npm install (first time only)
#
# Usage:
#   ./generate-weekly-report.sh
#
# Output:
#   output/consumer-apps-observability-report.html  (interactive charts)
#   output/consumer-apps-observability-report.pdf   (for email/Confluence)
#   output/charts/*.png                             (individual chart images)
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "📊 Consumer Apps & Services — Weekly Report Generator"
echo "====================================================="
echo ""

# Check node version
NODE_VERSION=$(node -v 2>/dev/null | cut -d'v' -f2 | cut -d'.' -f1)
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 20 ]; then
  echo "❌ Node.js 20+ required. Current: $(node -v 2>/dev/null || echo 'not found')"
  exit 1
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies (first time)..."
  npm install
  echo ""
fi

# Check AWS credentials
echo "🔐 Checking AWS credentials (profile: df-prod)..."
if ! aws sts get-caller-identity --profile df-prod > /dev/null 2>&1; then
  echo "❌ AWS credentials not configured. Run: aws sso login --profile df-prod"
  exit 1
fi
echo "   ✅ AWS credentials valid"
echo ""

# Step 1: Generate HTML report with charts (fetches data from CloudWatch)
echo "📈 Step 1/3: Fetching CloudWatch data & generating HTML report..."
echo "   This takes ~3 minutes (12 weeks × 6 services × 5 metrics)..."
echo ""
node src/generate-html-report.mjs
echo ""

# Step 2: Export chart images
echo "🖼️  Step 2/3: Exporting chart images..."
node src/export-chart-images.mjs
echo ""

# Step 3: Generate PDF
echo "📄 Step 3/3: Generating PDF..."
node src/export-pdf.mjs
echo ""

# Step 4: Publish to Confluence (optional)
echo ""
read -p "📤 Publish to Confluence? (y/N): " PUBLISH
if [ "$PUBLISH" = "y" ] || [ "$PUBLISH" = "Y" ]; then
  echo ""
  echo "Publishing to Confluence..."
  CONFLUENCE_USERNAME="${CONFLUENCE_USERNAME:-$JIRA_USERNAME}" \
  CONFLUENCE_API_TOKEN="${CONFLUENCE_API_TOKEN:-$JIRA_API_TOKEN}" \
  node src/publish-to-confluence.mjs
else
  echo "⏭️  Skipped Confluence publish."
fi

# Summary
echo "====================================================="
echo "✅ Report generation complete!"
echo ""
echo "📁 Output files:"
echo "   📊 HTML (interactive):  output/consumer-apps-observability-report.html"
echo "   📄 PDF (for email):     output/consumer-apps-observability-report.pdf"
echo "   🖼️  Charts (images):     output/charts/*.png"
echo ""
echo "📧 To share:"
echo "   1. Email: Attach the PDF file"
echo "   2. Confluence: Upload PDF + chart images to the page"
echo "   3. Browser: Open the HTML file for interactive charts"
echo ""
echo "====================================================="

# Open PDF in preview
open output/consumer-apps-observability-report.pdf 2>/dev/null || true
