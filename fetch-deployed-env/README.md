# 🚀 Fetch Deployed Environment

A bash script that fetches environment variables and secrets from AWS ECS task definitions and generates a local `.env` file for development purposes.

## 🎯 Purpose

This script helps developers quickly replicate the environment configuration of deployed applications by:
- Extracting environment variables from ECS task definitions
- Fetching secrets from AWS Secrets Manager
- Generating a local `.env` file with all configurations

Perfect for debugging, local development, or understanding deployed application configurations.

## 🚀 Quick Start

### Prerequisites
- **AWS CLI** installed and configured
- **jq** command-line JSON processor
- **Bash** shell (macOS/Linux)
- Appropriate AWS permissions for ECS and Secrets Manager

### Usage

```bash
./fetch-deployed-env.sh <task-definition-name> <output-file> [aws-profile]
```

#### Parameters
- `task-definition-name`: Name or ARN of the ECS task definition
- `output-file`: Path where the .env file will be created
- `aws-profile`: (Optional) AWS profile to use (defaults to 'default')

#### Examples

```bash
# Basic usage with default AWS profile
./fetch-deployed-env.sh my-app-task .env

# Using specific AWS profile
./fetch-deployed-env.sh my-app-task .env production

# Using task definition ARN
./fetch-deployed-env.sh arn:aws:ecs:us-east-1:123456789012:task-definition/my-app:1 .env

# Output to specific file
./fetch-deployed-env.sh my-app-task config/production.env dev-profile
```

## 📋 What It Extracts

### Environment Variables
Direct environment variables defined in the task definition:
```json
{
  "environment": [
    {"name": "NODE_ENV", "value": "production"},
    {"name": "PORT", "value": "3000"}
  ]
}
```

### Secrets from AWS Secrets Manager
Secrets referenced in the task definition:
```json
{
  "secrets": [
    {"name": "DATABASE_URL", "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/database-AbCdEf"},
    {"name": "API_KEY", "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/api-keys-XyZ123:api_key::"}
  ]
}
```

## 📊 Output Format

The generated `.env` file will contain:

```env
# Environment Variables
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

# Secrets from AWS Secrets Manager
DATABASE_URL=postgresql://user:pass@host:5432/db
API_KEY=sk-1234567890abcdef
JWT_SECRET=super-secret-key
```

## 🔧 How It Works

1. **Fetch Task Definition**: Uses `aws ecs describe-task-definition` to get the complete task definition
2. **Extract Environment Variables**: Parses the JSON to extract direct environment variables
3. **Process Secrets**: For each secret reference:
   - Extracts the Secrets Manager ARN
   - Fetches the secret value using `aws secretsmanager get-secret-value`
   - Handles both simple string secrets and JSON key-value secrets
4. **Generate .env File**: Writes all variables to the specified output file

## 🔄 Use Cases

### Local Development
```bash
# Fetch production config for local debugging
./fetch-deployed-env.sh prod-app-task .env.production

# Fetch staging config
./fetch-deployed-env.sh staging-app-task .env.staging
```


### Environment Comparison
```bash
# Compare different environments
./fetch-deployed-env.sh prod-task .env.prod
./fetch-deployed-env.sh staging-task .env.staging
diff .env.prod .env.staging
```

## 🚀 Advanced Usage

### Multiple Container Definitions
The script processes all containers in the task definition. If you need to target a specific container, you can modify the jq filter:

```bash
# Current (all containers):
jq -r '.taskDefinition.containerDefinitions[].environment[]'

# Specific container:
jq -r '.taskDefinition.containerDefinitions[] | select(.name=="my-container") | .environment[]'
```


---

**Part of the [Dev Toolbox](../) collection**
