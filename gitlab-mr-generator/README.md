# GitLab Merge Request Generator

A Node.js script to automatically create merge requests across multiple GitLab repositories with customizable configuration, user assignment, and batch processing capabilities.

## Pre-Requisites

1. **Node.js**: Version 14 or higher
2. **GitLab Access Token**: Personal or project access token with appropriate permissions
3. **Repository Access**: Read/write access to target GitLab repositories
4. **GitLab API Access**: Ensure the GitLab instance API is accessible

### Required Environment Variables

Set the following environment variables before running the script:

```bash
export GITLAB_BASE_URL="https://your-gitlab-instance.com"  # Default: https://gitlab.com
export GITLAB_TOKEN="your-gitlab-personal-access-token"
```

### Required GitLab Token Permissions

Your GitLab token needs the following scopes:
- `api` - Full API access
- `read_user` - Read user information
- `read_repository` - Read repository information
- `write_repository` - Create merge requests

## Installation

1. Navigate to the gitlab-mr-generator directory:
```bash
cd gitlab-mr-generator
```

2. Install dependencies:
```bash
npm install
# or
pnpm install
```

## Configuration - mrs.yml

The `mrs.yml` file contains the configuration for merge request creation. Here's a detailed explanation of each section:

### Global Defaults
These settings apply to all repositories unless overridden at the project level:

```yaml
# Branch configuration
source_branch: "develop"    # Source branch for merge requests
target_branch: "release"    # Target branch for merge requests

# Title configuration (choose one)
title: "Fixed title for all MRs"                    # Static title
title_template: "[VPT] Merge {source} → {target}"   # Dynamic title with placeholders

# Merge request settings
description: |
  Merges from develop to release.
labels: []                          # Array of label names
remove_source_branch: false         # Delete source branch after merge
squash: false                       # Squash commits when merging
draft: false                        # Create as draft MR
```

### User Assignment
Configure assignees and reviewers using email addresses:

```yaml
assignee_emails:
  - "user1@company.com"
  - "user2@company.com"

reviewer_emails:
  - "reviewer1@company.com"
  - "reviewer2@company.com"
```

### Email-to-Username Mapping
When email lookup fails, use username fallbacks:

```yaml
email_username_overrides:
  "user@company.com": "gitlab_username"
  "another@company.com": "another_username"
```

### Advanced Settings

```yaml
group_path: "your-group"              # Group path for member lookup
fail_on_user_lookup_error: true       # Fail if user lookup fails
skip_when_no_diff: true               # Skip if no changes between branches
```

### Repository Configuration

#### Option 1: Multiple Repositories
```yaml
projects:
  - project: "group/repo1"
  - project: "group/repo2"
    source_branch: "feature"    # Override global setting
    target_branch: "main"       # Override global setting
    title: "Custom title"       # Override global setting
```

#### Option 2: Single Repository
```yaml
project: "group/single-repo"
```

### Title Template Placeholders

Available placeholders for `title_template`:
- `{repo}` - Repository name (last part of project path)
- `{project}` - Full project path
- `{source}` - Source branch name
- `{target}` - Target branch name
- `{date}` - Current date (YYYY-MM-DD)

Example:
```yaml
title_template: "[{date}] Merge {repo}: {source} → {target}"
# Result: "[2025-09-10] Merge my-service: develop → release"
```

## Run Commands

### Basic Usage

Create merge requests using configuration file:
```bash
node create_mr.js --config mrs.yml
```

### Command Line Options

#### Dry Run Mode
Preview what would be created without actually creating merge requests:
```bash
node create_mr.js --config mrs.yml --dry-run
```

#### Custom Concurrency
Control how many repositories are processed simultaneously:
```bash
node create_mr.js --config mrs.yml --concurrency 8
```

#### Single Repository Override
Override configuration for a single repository:
```bash
node create_mr.js --config mrs.yml --project "group/specific-repo" --source "feature-branch" --target "main"
```

#### Alternative Config Flag
Use short form for config file:
```bash
node create_mr.js -c mrs.yml
```

### Complete Examples

1. **Standard batch processing:**
```bash
node create_mr.js --config mrs.yml
```

2. **Dry run with custom concurrency:**
```bash
node create_mr.js --config mrs.yml --dry-run --concurrency 2
```

3. **Single repository with branch override:**
```bash
node create_mr.js --config mrs.yml --project "mygroup/myrepo" --source "hotfix" --target "main"
```

4. **Using environment variables:**
```bash
GITLAB_BASE_URL="https://gitlab.example.com" GITLAB_TOKEN="glpat-xxx" node create_mr.js --config mrs.yml
```

## Output Examples

### Successful Creation
```
[CREATED] group/repo1  -> https://gitlab.com/group/repo1/-/merge_requests/123
[EXISTS ] group/repo2  -> https://gitlab.com/group/repo2/-/merge_requests/456
[SKIP   ] group/repo3  (reason: no-diff)
[ERROR  ] group/repo4  -> Project lookup failed: 404 Not Found

Summary: created=1, exists=1, skipped=1, dryrun=0, errors=1
```