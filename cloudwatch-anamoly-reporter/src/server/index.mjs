#!/usr/bin/env node
/**
 * Local HTTP Server - Serves HTML reports
 * Usage: npm run server
 */

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.LOCAL_SERVER_PORT || "3000");
const HOST = process.env.LOCAL_SERVER_HOST || "localhost";
const REPORTS_DIR = path.join(__dirname, "../../reports");

// Ensure reports directory exists
if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function findLatestReport(dashboardName) {
  const dashboardDir = path.join(REPORTS_DIR, dashboardName);
  if (!fs.existsSync(dashboardDir)) {
    return null;
  }

  const files = fs.readdirSync(dashboardDir)
    .filter(f => f.endsWith(".html"))
    .map(f => ({
      name: f,
      path: path.join(dashboardDir, f),
      mtime: fs.statSync(path.join(dashboardDir, f)).mtime
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return files.length > 0 ? files[0] : null;
}

function listAllReports() {
  const dashboards = fs.readdirSync(REPORTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  const reports = [];
  dashboards.forEach(dashboard => {
    const latest = findLatestReport(dashboard);
    if (latest) {
      reports.push({
        dashboard,
        file: latest.name,
        path: `/reports/${dashboard}/${latest.name}`,
        mtime: latest.mtime
      });
    }
  });

  return reports.sort((a, b) => b.mtime - a.mtime);
}

function generateIndexHTML(reports) {
  const reportsList = reports.map(r => `
    <li>
      <a href="${r.path}">${r.dashboard}</a>
      <span class="muted">(${r.mtime.toLocaleString()})</span>
    </li>
  `).join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>CloudWatch Anomaly Reports</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 40px; max-width: 1200px; }
    h1 { color: #1f2937; }
    ul { list-style: none; padding: 0; }
    li { padding: 12px; margin: 8px 0; background: #f9fafb; border-radius: 8px; border-left: 4px solid #3b82f6; }
    a { text-decoration: none; color: #2563eb; font-weight: 600; font-size: 16px; }
    a:hover { color: #1d4ed8; }
    .muted { color: #6b7280; font-size: 14px; margin-left: 12px; }
    .empty { color: #6b7280; font-style: italic; }
  </style>
</head>
<body>
  <h1>📊 CloudWatch Anomaly Reports</h1>
  ${reports.length > 0 ? `<ul>${reportsList}</ul>` : `<p class="empty">No reports found. Generate reports using: <code>npm run report -- --dashboard=DashboardName</code></p>`}
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  // Root - show index
  if (req.url === "/" || req.url === "/index.html") {
    const reports = listAllReports();
    const html = generateIndexHTML(reports);
    res.writeHead(200);
    res.end(html);
    return;
  }

  // Serve report files
  if (req.url.startsWith("/reports/")) {
    const filePath = path.join(REPORTS_DIR, req.url.replace("/reports/", ""));
    
    // Security: prevent directory traversal
    if (!filePath.startsWith(REPORTS_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    if (fs.existsSync(filePath) && filePath.endsWith(".html")) {
      const content = fs.readFileSync(filePath, "utf-8");
      res.writeHead(200);
      res.end(content);
    } else {
      res.writeHead(404);
      res.end("Report not found");
    }
    return;
  }

  // 404 for other routes
  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, HOST, () => {
  console.log(`🚀 Local report server running at http://${HOST}:${PORT}`);
  console.log(`📊 View reports at: http://${HOST}:${PORT}/`);
  console.log(`📁 Reports directory: ${REPORTS_DIR}`);
});

