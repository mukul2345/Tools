# CloudWatch Metrics Reports

A dependency-light CLI tool for generating CloudWatch metrics reports with latency (p90) and error analysis. Built with vanilla JavaScript (ESM), Node.js 20+, and AWS SDK v3.

---

## 🗓️ Weekly Observability Report (Consumer Apps & Services)

**One-click report generation** for the Engineering Excellence weekly review.

### Quick Start

```bash
cd cloudwatch-metrics-reports
./generate-weekly-report.sh
```

That's it. The script will:
1. Fetch 12 weeks of data from CloudWatch (traffic, errors, CPU, memory, latency)
2. Generate an interactive HTML report with charts
3. Export chart images as PNGs
4. Generate a PDF for email/Confluence
5. Open the PDF automatically

### Prerequisites

| Requirement | How to check | How to install |
|---|---|---|
| Node.js 20+ | `node -v` | `nvm install 20` |
| AWS SSO login | `aws sts get-caller-identity --profile df-prod` | `aws sso login --profile df-prod` |
| npm packages | First run auto-installs | `npm install` |

### Output Files

| File | Use for |
|---|---|
| `output/consumer-apps-observability-report.pdf` | Email attachment, Confluence upload |
| `output/consumer-apps-observability-report.html` | Open in browser for interactive charts |
| `output/charts/*.png` | Individual chart images for Confluence/Slack |

### Individual Commands

```bash
npm run html-report    # Generate HTML with interactive Chart.js graphs
npm run pdf-report     # Convert HTML to PDF (requires html-report first)
npm run email-report   # Generate email-friendly HTML (copy-paste into Gmail)
npm run traffic-trend  # Generate markdown/CSV trend data only
```

### What's in the report

- **Backend Services:** API Traffic, 5XX Error Rate, Log Ingestion (12-week trend)
- **Infrastructure:** CPU & Memory utilization per service
- **API Latency:** p90 latency trend per service
- **Client Portals:** Applicant, Client, Partner portal metrics (latency, errors, LCP, CLS)

### Confluence Page

The report lives at: [Trend Analysis - 12 Weeks](https://dataflowplus.atlassian.net/wiki/spaces/DEE/pages/4929814537) (under Engineering Excellence - Consumer Platform)

---

## 🎯 Purpose

This tool generates Markdown tables suitable for Confluence that analyze:

- **Latency Module**: API endpoints with p90 latency below/above a threshold, including request volume
- **Errors Module**: API endpoints with error counts below/above a threshold, including error ratios
- **ECS Resources Module**: CPU and Memory utilization for ECS services
- **SQS Age Module**: Age of oldest message in SQS queues for monitoring message backlogs
- **Lambda Performance Module**: Invocations, latency (p90), errors, and throttles for Lambda functions
- **Top APIs Module**: Top 20 APIs by total request volume for each service

The tool discovers all endpoints across specified services and status codes, fetches CloudWatch metrics, and outputs clean Markdown tables and CSV files ready for documentation and analysis.

## 🚀 Quick Start

### Prerequisites

- Node.js 20 or higher
- pnpm package manager
- AWS credentials configured (via AWS CLI, environment variables, or IAM role)
- CloudWatch metrics with the following structure:
  - Namespace: Custom namespace (e.g., `Your/Custom/Namespace`)
  - Metrics: `API_LATENCY`, `API_COUNT`
  - Dimensions: `ServiceName`, `endpoint`, `statusCode`

### Installation

```bash
cd cloudwatch-metrics-reports
pnpm install
```

### Configuration

1. Copy the example config:

```bash
cp config.example.json config.json
```

2. Edit `config.json` with your settings:

```json
{
  "modules": [
    "latency",
    "errors",
    "ecs-resources",
    "sqs-age",
    "lambda-performance",
    "top-apis"
  ],
  "topApisLimit": 20,
  "customNamespace": "Your/Custom/Namespace",
  "services": ["poi-service", "workflow-engine"],
  "statusCodesForLatency": ["200"],
  "statusCodesForErrors": ["400", "500", "4XX"],
  "periodSeconds": 60,
  "startISO": "2025-11-02T00:00:00+05:30",
  "endISO": "2025-11-02T23:59:59+05:30",
  "latencyThresholdMs": 100,
  "errorThreshold": 10,
  "ecsClusterName": "cluster-production-common",
  "ecsPeriodSeconds": 300,
  "sqsQueueNames": [
    {
      "queueName": "workflow-dlq",
      "serviceName": "verification-workflow-engine"
    },
    { "queueName": "payment-queue", "serviceName": "payment-service" }
  ],
  "sqsPeriodSeconds": 300,
  "lambdaFunctionNames": [
    {
      "functionName": "workflowProducer",
      "serviceName": "verification-workflow-engine"
    },
    { "functionName": "ProcessWorkflowEvents", "serviceName": "poi-service" },
    {
      "functionName": "RefundProcessor",
      "serviceName": "payment-service"
    }
  ],
  "lambdaPeriods": {
    "invocationsPeriod": 300,
    "durationPeriod": 300,
    "errorsPeriod": 300,
    "throttlesPeriod": 300
  }
}
```

### Usage

**Run all modules (generates 10 files - 5 Markdown + 5 CSV):**

```bash
pnpm start
```

**Run specific module:**

```bash
node src/index.mjs --module latency
node src/index.mjs --module errors
node src/index.mjs --module ecs-resources
node src/index.mjs --module sqs-age
node src/index.mjs --module lambda-performance
node src/index.mjs --module top-apis
```

**Run multiple modules:**

```bash
# Run latency and ECS resources only
node src/index.mjs --module latency --module ecs-resources

# Run all AWS-native modules
node src/index.mjs --module ecs-resources --module sqs-age --module lambda-performance
```

**Override config with CLI flags:**

```bash
node src/index.mjs \
  --start "2025-11-02T00:00:00+05:30" \
  --end "2025-11-02T23:59:59+05:30" \
  --latencyThresholdMs 200 \
  --errorThreshold 5
```

**Output Files:**

All files are written to the `./output/` directory with descriptive names:

- **Markdown files** (for Confluence): `latency-above-2025-11-03-14-30-45.md`
- **CSV files** (for Excel): `latency-above-2025-11-03-14-30-45.csv`
- Filenames include: `{module}-{filterMode}-{timestamp}.{ext}`

```bash
# Example output:
📁 Generated Files:
==================================================
  Latency Markdown     ./output/latency-above-2025-11-03-14-30-45.md
  Latency CSV          ./output/latency-above-2025-11-03-14-30-45.csv
  Errors Markdown      ./output/errors-below-2025-11-03-14-30-45.md
  Errors CSV           ./output/errors-below-2025-11-03-14-30-45.csv
==================================================
```

## 📝 Configuration Options

| Field                   | Type     | Required | Default                                                                              | Description                                                                                      |
| ----------------------- | -------- | -------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `modules`               | string[] | No       | `["latency","errors","ecs-resources","sqs-age","lambda-performance"]`                | Modules to run (can be overridden via CLI)                                                       |
| `customNamespace`       | string   | Yes      | -                                                                                    | CloudWatch custom namespace for API metrics                                                      |
| `services`              | string[] | Yes      | -                                                                                    | List of ServiceName values to analyze                                                            |
| `statusCodesForLatency` | string[] | No       | `["200"]`                                                                            | Status codes considered "success" for latency                                                    |
| `statusCodesForErrors`  | string[] | No       | `["400", "500", "4XX"]`                                                              | Status codes considered "errors"                                                                 |
| `periodSeconds`         | number   | Yes      | -                                                                                    | CloudWatch period for API metrics (1, 5, 10, 30, or multiple of 60)                              |
| `startISO`              | string   | Yes      | -                                                                                    | Start time in ISO 8601 format with timezone                                                      |
| `endISO`                | string   | Yes      | -                                                                                    | End time in ISO 8601 format with timezone                                                        |
| `latencyThresholdMs`    | number   | No       | 100                                                                                  | Latency threshold in milliseconds                                                                |
| `latencyFilterMode`     | string   | No       | `"below"`                                                                            | Filter mode: `"below"` or `"above"`                                                              |
| `errorThreshold`        | number   | No       | 10                                                                                   | Error count threshold                                                                            |
| `errorFilterMode`       | string   | No       | `"below"`                                                                            | Filter mode: `"below"` or `"above"`                                                              |
| `ecsClusterName`        | string   | No       | `"cluster-production-common"`                                                        | ECS cluster name for resource metrics                                                            |
| `ecsPeriodSeconds`      | number   | No       | 300                                                                                  | CloudWatch period for ECS metrics (separate from API metrics)                                    |
| `sqsQueueNames`         | object[] | No       | `[]`                                                                                 | List of queue objects with `queueName` and `serviceName` for SQS age monitoring                  |
| `sqsPeriodSeconds`      | number   | No       | 300                                                                                  | CloudWatch period for SQS metrics                                                                |
| `lambdaFunctionNames`   | object[] | No       | `[]`                                                                                 | List of function objects with `functionName` and `serviceName` for Lambda performance monitoring |
| `lambdaPeriods`         | object   | No       | `{invocationsPeriod:300, durationPeriod:300, errorsPeriod:300, throttlesPeriod:300}` | Individual periods for each Lambda metric                                                        |
| `topApisLimit`          | number   | No       | 20                                                                                   | Number of top APIs to return per service in the `top-apis` module                               |

### Filter Modes

**Filter modes control which APIs are included in the report:**

- **`"below"`** (default): Shows APIs performing **better** than the threshold
  - Latency: p90 **<** threshold (good performers)
  - Errors: error count **<** threshold (low error rates)
- **`"above"`**: Shows APIs performing **worse** than the threshold
  - Latency: p90 **>** threshold (needs optimization)
  - Errors: error count **>** threshold (high error rates)

### Status Code Patterns

Status codes support wildcard patterns:

- `"200"` - Exact match
- `"4XX"` - Matches 400-499
- `"5XX"` - Matches 500-599

## 🔧 CLI Options

```
Options:
  --config <path>              Path to config JSON file (default: ./config.json)
  --start <iso-datetime>       Start time (ISO format with timezone)
  --end <iso-datetime>         End time (ISO format with timezone)
  --period <seconds>           Period in seconds
  --latencyThresholdMs <ms>    Latency threshold in milliseconds
  --errorThreshold <count>     Error count threshold
  --module <module>            Module to run: 'latency', 'errors', 'ecs-resources', 'sqs-age', 'lambda-performance', or 'top-apis' (can be repeated)
  --namespace <namespace>      CloudWatch namespace
  --services <svc1,svc2>       Comma-separated service list
  --help, -h                   Show help message
```

## 📊 Output Format

### Latency Report

```markdown
## Latency Report (p90 < Threshold)

| APIs        | Service         | p90 (ms) | Volume | Target p90 | Status | DueDate |
| ----------- | --------------- | -------- | ------ | ---------- | ------ | ------- |
| /api/users  | poi-service     | 45.23    | 15000  | 100        |        |         |
| /api/orders | workflow-engine | 78.91    | 8500   | 100        |        |         |

**Total APIs:** 2
```

### Error Report

```markdown
## Error Report (Error Count < Threshold)

| APIs        | Service         | Error Count | Total Count | Error Ratio | Status | Remarks |
| ----------- | --------------- | ----------- | ----------- | ----------- | ------ | ------- |
| /api/users  | poi-service     | 5           | 15000       | 0.03%       |        |         |
| /api/orders | workflow-engine | 2           | 8500        | 0.02%       |        |         |

**Total APIs:** 2
```

### ECS Resources Report

```markdown
## ECS Resource Utilization Report

| Service              | CPU (avg) % | Memory (avg) % |
| -------------------- | ----------- | -------------- |
| payment-service      | 23.45       | 38.92          |
| poi-service          | 78.90       | 85.47          |
| verification-request | 45.32       | 62.18          |

**Total Services:** 3
```

**Note**: The ECS module automatically appends `-production-common` to service names when querying AWS/ECS metrics.

### SQS Age Report

```markdown
## SQS Age of Oldest Message Report

| Queue              | Age of Oldest Message (seconds) | Status |
| ------------------ | ------------------------------- | ------ |
| notification-queue | 0                               |        |
| payment-dlq        | 125                             |        |
| workflow-dlq       | 3665                            |        |

**Total Queues:** 3
```

### Lambda Performance Report

```markdown
## Lambda Performance Report

| Lambda                       | Invocations | Latency (p90) | Errors | Throttles | Status |
| ---------------------------- | ----------- | ------------- | ------ | --------- | ------ |
| document-management-service  | 45678       | 156           | 3      | 0         |        |
| payment-service              | 67890       | 290           | 8      | 1         |        |
| poi-service                  | 89234       | 180           | 5      | 2         |        |
| verification-request         | 234567      | 320           | 45     | 15        |        |
| verification-workflow-engine | 125430      | 245           | 12     | 0         |        |

**Total Functions:** 5
```

**Note**: Lambda Duration (latency) is reported in milliseconds.

### Top APIs Report

```markdown
## Top APIs by Request Volume

### poi-service

| Rank | Endpoint              | Request Count |
|------|-----------------------|---------------|
| 1    | /api/v1/poi/search    | 125430        |
| 2    | /api/v1/poi/details   | 89234         |
| 3    | /api/v1/poi/create    | 34567         |

**Total APIs shown:** 3

### payment-service

| Rank | Endpoint              | Request Count |
|------|-----------------------|---------------|
| 1    | /api/v1/payment       | 67890         |
| 2    | /api/v1/refund        | 12345         |

**Total APIs shown:** 2
```

## 🏗️ Architecture

```
src/
├── index.mjs        # CLI entrypoint, argument parsing, orchestration
├── cloudwatch.mjs   # AWS SDK v3 wrapper with pagination & backoff
├── discovery.mjs    # Metric discovery and data processing
├── markdown.mjs     # Markdown table rendering
├── time.mjs         # Time parsing and validation
├── config.mjs       # Configuration loading and validation
└── logger.mjs       # Minimal logger (honors LOG_LEVEL)
```

### How It Works

1. **Discovery**: Uses `ListMetrics` to discover all unique (ServiceName, endpoint) combinations
2. **Data Fetching**: Uses `GetMetricData` to fetch p90 latency and API counts in batches (500 queries/call)
3. **Processing**: Aggregates data, converts units, applies filters
4. **Rendering**: Generates clean Markdown tables sorted by service and endpoint

## 🔐 AWS IAM Permissions

Required IAM permissions for the AWS credentials:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["cloudwatch:ListMetrics", "cloudwatch:GetMetricData"],
      "Resource": "*"
    }
  ]
}
```

## 🌍 Environment Variables

| Variable                | Description                                     | Default     |
| ----------------------- | ----------------------------------------------- | ----------- |
| `LOG_LEVEL`             | Logging level: `error`, `warn`, `info`, `debug` | `info`      |
| `AWS_REGION`            | AWS region                                      | SDK default |
| `AWS_PROFILE`           | AWS profile to use                              | SDK default |
| `AWS_ACCESS_KEY_ID`     | AWS access key                                  | -           |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key                                  | -           |

## 📈 Examples

### Daily Report for Production

```bash
node src/index.mjs \
  --config ./config.json \
  --start "2025-11-02T00:00:00+05:30" \
  --end "2025-11-02T23:59:59+05:30" \
  --period 300
# Outputs to ./output/ directory
```

### High-Performance APIs (Latency < 50ms)

```bash
node src/index.mjs \
  --module latency \
  --latencyThresholdMs 50 \
  --latencyFilterMode below
# Generates: latency-below-{timestamp}.md and .csv
```

### Problem APIs (Latency > 300ms) - **Your Use Case!**

```bash
node src/index.mjs \
  --module latency \
  --latencyThresholdMs 300 \
  --latencyFilterMode above
# Generates: latency-above-{timestamp}.md and .csv
```

Or in your `config.json`:

```json
{
  "latencyThresholdMs": 300,
  "latencyFilterMode": "above"
}
```

### High Error Rate APIs (Error Count > 100)

```bash
node src/index.mjs \
  --module errors \
  --errorThreshold 100 \
  --errorFilterMode above
# Generates: errors-above-{timestamp}.md and .csv
```

### Error Analysis for Specific Services

```bash
node src/index.mjs \
  --module errors \
  --services "payment-service,auth-service" \
  --errorThreshold 100 \
  > error-analysis.md
```

### Top 20 APIs by Request Volume

```bash
node src/index.mjs --module top-apis
# Generates: top-apis-all-{timestamp}.md and .csv
```

To override the limit (e.g. top 10):

```json
{ "topApisLimit": 10 }
```

### Debug Mode

```bash
LOG_LEVEL=debug node src/index.mjs --module latency 2> debug.log
```

## 🐛 Troubleshooting

### No data in output

- Verify CloudWatch namespace and metric names
- Check that dimensions match: `ServiceName`, `endpoint`, `statusCode`
- Ensure time range covers periods with actual data
- Run with `LOG_LEVEL=debug` to see discovery details

### Throttling errors

- The tool includes exponential backoff with jitter
- Consider reducing the number of services or time range
- Increase period to reduce data points

### Missing endpoints

- Ensure status codes in config match actual metrics
- Check that services list includes the ServiceName values
- Verify metrics exist in CloudWatch for the time range

### Unit conversion issues

- Tool assumes latency < 10 is in seconds and converts to ms
- Verify your metrics are published in the expected units

## 🤝 Contributing

This script follows the standards defined in the parent repository's [CONTRIBUTING.md](../CONTRIBUTING.md).

### Code Standards

- ESM modules (`.mjs` extension)
- No TypeScript or transpilation
- Minimal dependencies (only `@aws-sdk/client-cloudwatch`)
- Logs to stderr, output to stdout
- Comprehensive error handling with meaningful messages

## 📄 License

ISC

---

**Part of the [Dev Toolbox](../README.md) collection**

For issues or questions, please refer to the main repository documentation.
