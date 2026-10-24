# Newman Screenshot Runner

Automates API testing using Postman collections and captures screenshots of each request/response for documentation or reporting purposes.

## Features

- Run Postman collections via Newman
- Capture screenshots of each API request/response
- CLI-based with flexible options
- Sequential numbering of screenshots for easy ordering
- HTML escaping for safe rendering
- Status code color coding (green for success, red for errors)

## Installation

```bash
cd dev-testing-automation
npm install
```

## Usage

```bash
node newman-screenshot-runner.js <collection-path> [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `collection-path` | Path to the Postman collection JSON file (required) |

### Options

| Option | Description |
|--------|-------------|
| `-o, --output <dir>` | Output directory for screenshots (default: `./screenshots`) |
| `-h, --help` | Show help message |

### Examples

```bash
# Basic usage
node newman-screenshot-runner.js ./my-collection.json

# Specify custom output directory
node newman-screenshot-runner.js ./api-tests.json -o ./test-results

# Using absolute paths
node newman-screenshot-runner.js /path/to/collection.json --output /path/to/output
```

## Output

Screenshots are saved as PNG files with the naming convention:
```
{index}_{request_name}.png
```

For example:
- `1_Get_Users.png`
- `2_Create_User.png`
- `3_Delete_User.png`

## Requirements

- Node.js 14+
- A valid Postman collection JSON file (exported from Postman)

## Exporting a Collection from Postman

1. Open Postman
2. Right-click on your collection
3. Select "Export"
4. Choose "Collection v2.1" format
5. Save the JSON file

## Screenshot Contents

Each screenshot includes:
- **Request Name**: The name of the API request
- **Request Method & URL**: The HTTP method and endpoint
- **Request Body**: Partial view of the request body (truncated to 300 chars)
- **Response Output**: Partial view of the response (truncated to 1000 chars) with status code

