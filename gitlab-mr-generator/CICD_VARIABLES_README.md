# GitLab CI/CD Variables Manager

A Node.js script to add, update, or delete CI/CD variables across multiple GitLab projects in bulk.

## Features

- ✅ Add CI/CD variables to multiple projects at once
- ✅ Update existing variables across projects
- ✅ Delete variables from multiple projects
- ✅ Support for all GitLab variable types (env_var, file)
- ✅ Support for protected, masked, and raw variables
- ✅ Environment-scoped variables
- ✅ Dry-run mode to preview changes
- ✅ Concurrent processing with configurable concurrency
- ✅ Skip existing variables (default) or force update
- ✅ Detailed reporting of operations

## Prerequisites

- Node.js (v14 or higher)
- GitLab personal access token with `api` scope
- Access to the GitLab projects you want to modify

## Installation

```bash
cd gitlab-mr-generator
pnpm install
```

## Configuration

### Environment Variables

Create a `.env` file or export these variables:

```bash
export GITLAB_BASE_URL="https://gitlab.com"  # or your GitLab instance URL
export GITLAB_TOKEN="your-personal-access-token"
```

### Configuration File

Create a YAML configuration file (e.g., `variables.yml`) based on `variables.example.yml`:

```yaml
# Global defaults
variable_type: env_var
protected: false
masked: false
raw: false
environment_scope: "*"

# Variables to manage
variables:
  - key: "DATABASE_URL"
    value: "postgres://user:pass@host:5432/db"
    protected: true
    masked: true

  - key: "API_KEY"
    value: "your-secret-api-key"
    protected: true
    masked: true

# Projects to apply variables to
projects:
  - project: "group/subgroup/project1"
  - project: "group/subgroup/project2"
```

## Usage

### Basic Usage

Add variables to all projects (skip existing):

```bash
node add_cicd_variables.js --config variables.yml
```

### Dry Run (Preview Changes)

Preview what would be changed without making actual changes:

```bash
node add_cicd_variables.js --config variables.yml --dry-run
```

### Update Existing Variables

Update variables even if they already exist:

```bash
node add_cicd_variables.js --config variables.yml --update
```

### Delete Variables

Delete specified variables from all projects:

```bash
node add_cicd_variables.js --config variables.yml --delete
```

### Adjust Concurrency

Process more or fewer projects simultaneously:

```bash
node add_cicd_variables.js --config variables.yml --concurrency 10
```

## Configuration Options

### Global Defaults

These apply to all variables unless overridden:

| Option              | Type    | Default   | Description                                |
| ------------------- | ------- | --------- | ------------------------------------------ |
| `variable_type`     | string  | `env_var` | Variable type: `env_var` or `file`         |
| `protected`         | boolean | `false`   | Available only on protected branches/tags  |
| `masked`            | boolean | `false`   | Hidden in job logs                         |
| `raw`               | boolean | `false`   | Disable variable expansion                 |
| `environment_scope` | string  | `*`       | Environment scope: `*` or environment name |

### Per-Variable Settings

Each variable supports:

| Field               | Required | Description                                   |
| ------------------- | -------- | --------------------------------------------- |
| `key`               | ✅ Yes   | Variable name                                 |
| `value`             | No       | Variable value (empty string if not provided) |
| `variable_type`     | No       | Override global `variable_type`               |
| `protected`         | No       | Override global `protected`                   |
| `masked`            | No       | Override global `masked`                      |
| `raw`               | No       | Override global `raw`                         |
| `environment_scope` | No       | Override global `environment_scope`           |

### Projects

Same format as `mrs.yml`:

```yaml
projects:
  - project: "group/subgroup/repo-name"
```

## Command Line Options

| Option          | Description                                  |
| --------------- | -------------------------------------------- |
| `--config, -c`  | Path to YAML configuration file (required)   |
| `--dry-run`     | Preview changes without applying them        |
| `--update`      | Update existing variables (default: skip)    |
| `--delete`      | Delete specified variables                   |
| `--concurrency` | Number of concurrent operations (default: 4) |

## Examples

### Example 1: Add deployment variables

```yaml
# deploy-vars.yml
protected: true
masked: true

variables:
  - key: "DEPLOY_TOKEN"
    value: "secret-token-123"
  - key: "DEPLOY_ENV"
    value: "production"
    masked: false

projects:
  - project: "mygroup/backend"
  - project: "mygroup/frontend"
```

```bash
node add_cicd_variables.js --config deploy-vars.yml
```

### Example 2: Update database URLs

```yaml
# db-urls.yml
protected: true
masked: true

variables:
  - key: "DATABASE_URL"
    value: "postgres://new-host:5432/db"

projects:
  - project: "mygroup/api-service"
  - project: "mygroup/worker-service"
```

```bash
# Preview the update
node add_cicd_variables.js --config db-urls.yml --update --dry-run

# Apply the update
node add_cicd_variables.js --config db-urls.yml --update
```

### Example 3: Delete old variables

```yaml
# cleanup-vars.yml
variables:
  - key: "OLD_API_KEY"
  - key: "DEPRECATED_CONFIG"

projects:
  - project: "mygroup/legacy-app"
```

```bash
node add_cicd_variables.js --config cleanup-vars.yml --delete
```

### Example 4: Environment-scoped variables

```yaml
# env-specific.yml
variables:
  - key: "API_URL"
    value: "https://api.staging.example.com"
    environment_scope: "staging"

  - key: "API_URL"
    value: "https://api.production.example.com"
    environment_scope: "production"
    protected: true

projects:
  - project: "mygroup/web-app"
```

```bash
node add_cicd_variables.js --config env-specific.yml
```

## Output

The script provides detailed output:

```
Processing 12 projects with 3 variables...
Mode: CREATE (skip existing)

================================================================================
RESULTS
================================================================================

group/project1
--------------
  ✓ [CREATED] DATABASE_URL
  ✓ [CREATED] API_KEY
  - [SKIPPED] NODE_ENV (exists)

group/project2
--------------
  ✓ [CREATED] DATABASE_URL
  ✓ [CREATED] API_KEY
  ✓ [CREATED] NODE_ENV

================================================================================
SUMMARY
================================================================================
Projects processed: 2
Variables created:  5
Variables updated:  0
Variables deleted:  0
Variables skipped:  1
Variables not found: 0
Dry-run operations: 0
Errors:            0
================================================================================
```

## Best Practices

1. **Always test with --dry-run first**: Preview changes before applying them
2. **Use masked variables for secrets**: Set `masked: true` for sensitive values
3. **Protect production variables**: Set `protected: true` for production environments
4. **Use environment scoping**: Create environment-specific variables when needed
5. **Start with low concurrency**: Use `--concurrency 2` for initial runs
6. **Keep backups**: Document existing variables before bulk updates
7. **Use file variables for configs**: Set `variable_type: file` for configuration files

## Troubleshooting

### Authentication Errors

- Verify `GITLAB_TOKEN` has `api` scope
- Check `GITLAB_BASE_URL` is correct
- Ensure token has access to all projects

### Variable Not Created

- Check if variable already exists (use `--update` to force)
- Verify project path is correct
- Ensure you have maintainer/owner role on the project

### Rate Limiting

- Reduce `--concurrency` value
- Add delays between operations if needed

## Related Scripts

- `create_mr.js`: Create merge requests across multiple repositories
- `mrs.yml`: Merge request configuration (shares project format)

## License

ISC
