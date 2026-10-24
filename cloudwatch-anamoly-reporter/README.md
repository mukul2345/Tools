# CloudWatch Anomaly Reporter

A tool to detect statistical anomalies in CloudWatch metrics and generate HTML reports.

**📊 [View Sample Report](sample-report.pdf)**

## Quick Start

### 1. Extract Widget Configuration from CloudWatch Dashboard

1. Go to your CloudWatch dashboard
2. Click on any widget you want to analyze
3. Click **"Edit"** → **"Source"** tab
4. Copy the JSON and save it as `widgets/widget-name.json`

Example widget JSON:
```json
{
  "type": "metric",
  "title": "API Latency",
  "region": "us-east-1",
  "metrics": [
    ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", "my-alb"]
  ],
  "stat": "Average"
}
```

### 2. Convert Widgets to Configurations

Update default settings in `widgets-to-configs.mjs` if needed:
```javascript
const cfg = {
  periodSeconds: 900,     // 15 minutes
  windowMinutes: 480,     // 8 hours (current window)
  baselineDays: 7,        // Compare with last 7 days
  minSamples: 10,         // Minimum data points
  zThreshold: 3.0,        // Statistical threshold
  pctThreshold: 40,       // Percentage change threshold
  timezone: "Asia/Kolkata",
  skipWeekends: false,
  // ...
};
```

Run the conversion:
```bash
npm run convert-widgets
```

This creates config files in the `configs/` folder.

### 3. Generate Anomaly Report

```bash
npm run report
```

This generates `report.html` with anomaly analysis.

#### Report Options

```bash
# Generate for specific time
npm run report -- --end=2024-01-15T10:00:00Z

# Also save JSON output
npm run report -- --json=report.json

# Run single config
node run-config.mjs configs/config.api-latency.json
```

## How It Works

The script compares current metrics with historical baselines using robust statistics:

1. **Current Window**: Last N hours of data (default: 8 hours)
2. **Baseline**: Same time window from previous N days (default: 7 days)  
3. **Detection**: Uses Z-score (statistical significance) AND percentage change (practical significance)

### Statistical Method
- Uses **Median Absolute Deviation (MAD)** instead of standard deviation (more robust to outliers)
- Z-score = (Current - Baseline_Median) / (MAD × 1.4826)
- Flags anomaly if: `|Z-score| ≥ 3.0` AND `|Percentage_Change| ≥ 40%`

## Reading the Report

### Report Columns
- **Curr**: Current window value
- **BaseMed**: Median of baseline windows  
- **Δ%**: Percentage change from baseline
- **Z**: Z-score (how many "typical variations" away from normal)
- **Anom**: "YES" if anomaly detected

### What to Focus On
✅ **Investigate**: Rows marked "YES" in Anom column  
✅ **High Z-scores**: |Z| > 5 indicates significant deviation  
✅ **Large % changes**: >100% changes in key metrics  

### What to Ignore
❌ **Low sample counts**: Pts < 10 (insufficient data)  
❌ **Small absolute changes**: Large % but tiny absolute values  
❌ **Expected patterns**: Known maintenance windows, deployments  

## Package Scripts

```bash
npm run convert-widgets  # Convert widgets/ to configs/
npm run report          # Generate full HTML report
npm run single          # Run single config (edit package.json first)
```
