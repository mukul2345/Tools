# 🧰 Dev Toolbox

A centralized repository for reusable scripts, utilities, and automation tools that ## 📝 Contributing Guidelines

For detailed contribution guidelines, see [CONTRIBUTING.md](./CONTRIBUTING.md).

### Adding a New Script be leveraged across the organization. This repository aims to eliminate code duplication, promote best practices, and accelerate development workflows.

## 📋 Repository Structure

Each script or utility in this repository follows a consistent structure:

- **Individual folders** for each script/utility
- **README.md** in each folder explaining purpose, usage, and setup
- **Self-contained** with all necessary dependencies and configuration

```
dev-toolbox/
├── README.md                          # This file
├── .gitignore                         # Git ignore patterns
├── workflow-analysis/                 # Workflow data analysis tools
├── master-contracts/                  # Client contract Excel generation
├── workflow-sqs-dlq-poller/          # SQS Dead Letter Queue polling utility
└── [other-scripts]/                  # Additional utilities...
```

## 🚀 Getting Started

1. **Clone the repository**

   ```bash
   git clone <repository-url>
   cd dev-toolbox
   ```

2. **Navigate to the script you need**

   ```bash
   cd <script-folder>
   ```

3. **Follow the script-specific README**
   Each script folder contains detailed setup and usage instructions.

## 🏃‍♂️ Quick Examples

### Analyze Workflow Data

```bash
cd workflow-analysis
npm install  # if needed
node extract-workflow-ids.js
node workflow-intersection-analysis.js
```

### Generate Contract Reports

```bash
cd master-contracts
npm install
cp .env.example .env  # Configure AWS credentials
npm start
```

### Poll SQS Dead Letter Queue

```bash
cd workflow-sqs-dlq-poller
npm install
cp .env.example .env  # Configure AWS and SQS settings
npm start
```

### Fetch Deployed Environment Variables

```bash
cd fetch-deployed-env
chmod +x fetch-deployed-env.sh
./fetch-deployed-env.sh my-task-definition .env production
```

### Generate CloudWatch Metrics Reports

```bash
cd cloudwatch-metrics-reports
npm install

# One command — generates 12-week CPU + Memory data with charts
npm run weekly-report

# Or with custom parameters
node src/generate-weekly-report.mjs --period 300 --weeks 12
```

**Parameters:**
| Flag | Default | Description |
|------|---------|-------------|
| `--period` | `300` | CloudWatch aggregation period (seconds). 300 = 5-min granularity |
| `--weeks` | `12` | Number of weeks to look back from current Monday |

**Output:**
- `output/cpu-utilisation-report.csv` — Weekly CPU data per service
- `output/memory-utilisation-report.csv` — Weekly Memory data per service
- `output/cpu-utilisation-charts.html` — Interactive dual-axis charts (CPU vs API requests)
- `output/memory-utilisation-charts.html` — Interactive dual-axis charts (Memory vs API requests)

**Individual metric fetch:**
```bash
node src/fetch-cpu-mem-latency.mjs --metric cpu --period 300 --weeks 12
node src/fetch-cpu-mem-latency.mjs --metric memory --period 300 --weeks 12
```

**Latency & Error reports (requires network to AWS):**
```bash
node src/index.mjs --config ./config.json --module latency --module error
```

### Get Troubled Workflow Counts

1. Open https://workflowdashboard.dataflowgroup.com/dashboard/trouble-workflows in your browser
2. Open DevTools → Sources → Snippets
3. Create a new snippet, paste `troubled-workflow-count-snippet/troubledWorkflowCountRetrieve.js`, and run it
4. Copy the formatted output from the Console

## 📁 Available Scripts

| Script                                                      | Description                                                                             | Technology          | Status   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------- | -------- |
| [workflow-analysis](./workflow-analysis/)                   | Tools for analyzing workflow data, extracting IDs, and performing intersection analysis | Node.js             | ✅ Ready |
| [master-contracts](./master-contracts/)                     | Generate Excel reports for client contracts from DynamoDB                               | Node.js, AWS SDK    | ✅ Ready |
| [workflow-sqs-dlq-poller](./workflow-sqs-dlq-poller/)       | Poll and analyze messages from SQS Dead Letter Queues                                   | Node.js, AWS SDK    | ✅ Ready |
| [fetch-deployed-env](./fetch-deployed-env/)                 | Fetch environment variables and secrets from AWS ECS task definitions                   | Bash, AWS CLI       | ✅ Ready |
| [cloudwatch-metrics-reports](./cloudwatch-metrics-reports/) | Weekly CPU/Memory utilisation trends with dual-axis charts + Latency/Error reports | Node.js, AWS SDK v3, Chart.js | ✅ Ready |
| [mohap-aes-payload-crypto](./mohap-aes-payload-crypto/)     | MOHAP payload encrypt/decrypt and `x-Sec-Token` generation (AES-256-CBC, Narada-compatible) | Node.js             | ✅ Ready |
| [troubled-workflow-count-snippet](./troubled-workflow-count-snippet/) | Browser DevTools snippet to scrape and report case counts from the Troubled Workflows dashboard | Browser JS (Snippet) | ✅ Ready |

## 🎯 Script Categories

### 📊 Data Analysis & Reporting

- **[workflow-analysis](./workflow-analysis/)** - Extract and analyze workflow execution patterns
- **[master-contracts](./master-contracts/)** - Generate comprehensive client contract reports
- **[cloudwatch-metrics-reports](./cloudwatch-metrics-reports/)** - Generate CloudWatch latency and error metrics reports for Confluence
- **[troubled-workflow-count-snippet](./troubled-workflow-count-snippet/)** - Scrape and report case counts from the Troubled Workflows dashboard

### ☁️ AWS Infrastructure Tools

- **[workflow-sqs-dlq-poller](./workflow-sqs-dlq-poller/)** - SQS Dead Letter Queue message processing
- **[master-contracts](./master-contracts/)** - DynamoDB data extraction and reporting
- **[fetch-deployed-env](./fetch-deployed-env/)** - Extract environment variables from ECS task definitions
- **[cloudwatch-metrics-reports](./cloudwatch-metrics-reports/)** - CloudWatch metrics analysis and reporting

### 🔧 Development Utilities

- Build automation scripts _(coming soon)_
- Environment setup tools _(coming soon)_
- Testing utilities _(coming soon)_

## �️ Helper Tools

### Script Generator

Use the included script generator to quickly create new scripts with proper structure:

```bash
node create-script.js script-name "Optional description"
```

This will create:

- Folder with proper structure
- `package.json` with standard configuration
- `README.md` template
- `.env.example` file
- Basic `index.js` and `test.js` files

## �📝 Contributing Guidelines

### Adding a New Script

1. **Use the script generator** (recommended)

   ```bash
   node create-script.js my-awesome-script "Description of what it does"
   ```

2. **Or create manually** with a dedicated folder

   ```bash
   mkdir my-awesome-script
   cd my-awesome-script
   ```

3. **Include a comprehensive README.md** with:

   - Purpose and use cases
   - Prerequisites and dependencies
   - Installation instructions
   - Usage examples
   - Configuration options
   - Troubleshooting guide

4. **Follow the folder template**:

   ```
   my-awesome-script/
   ├── README.md              # Detailed documentation
   ├── package.json           # Dependencies (if Node.js)
   ├── .env.example          # Environment template
   ├── src/                  # Source code
   ├── examples/             # Usage examples
   └── docs/                 # Additional documentation
   ```

5. **Update the main README** to include your script in the "Available Scripts" table

### Best Practices

- ✅ **Self-contained**: Each script should be independent
- ✅ **Well-documented**: Clear README with examples
- ✅ **Environment variables**: Use `.env` files for configuration
- ✅ **Error handling**: Robust error handling and logging
- ✅ **Dependencies**: Lock dependency versions
- ✅ **Examples**: Provide working examples
- ✅ **Gitignore**: Don't commit sensitive data or outputs

## 🔒 Security Notes

- Never commit credentials, API keys, or sensitive data
- Use `.env` files with `.env.example` templates
- Add sensitive patterns to `.gitignore`
- Follow least privilege principles for AWS permissions

---

**Happy Scripting! 🎉**

> _"The best scripts are the ones that solve real problems and can be easily reused by others."_
