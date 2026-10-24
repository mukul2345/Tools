# Contributing to Dev Toolbox

Thank you for contributing to the Dev Toolbox! This document provides guidelines and best practices for adding new scripts and maintaining the repository.

## 🚀 Quick Start for Contributors

### Using the Script Generator
The fastest way to add a new script:

```bash
node create-script.js your-script-name "Brief description of what it does"
```

This automatically creates the proper folder structure and templates.

### Manual Setup
If you prefer to create everything manually:

```bash
mkdir your-script-name
cd your-script-name
# Create the required files (see structure below)
```

## 📁 Required Folder Structure

Every script must follow this structure:

```
your-script-name/
├── README.md              # Detailed documentation
├── package.json           # Node.js dependencies (if applicable)
├── .env.example          # Environment template
├── index.js              # Main script file
├── test.js               # Basic tests
└── [additional files]    # As needed
```

## 📝 Documentation Requirements

### README.md Template
Each script must include a comprehensive README with these sections:

```markdown
# Script Name

Brief description of what the script does.

## 🎯 Purpose
Detailed explanation of use cases and problems it solves.

## 🚀 Quick Start
### Prerequisites
### Installation
### Usage

## 📝 Configuration
Environment variables and configuration options.

## 📊 Examples
Real-world usage examples with sample inputs/outputs.

## 🔧 Options
Command-line options and parameters.

## 📁 Output
Description of generated files or outputs.

## 🐛 Troubleshooting
Common issues and solutions.

## 🤝 Contributing
How others can extend or modify the script.
```

### Code Documentation
- Include clear comments in your code
- Use JSDoc for function documentation
- Explain complex logic or algorithms
- Provide examples in code comments

## 🏗️ Code Standards

### File Naming
- Use kebab-case for folder names: `data-processor`
- Use camelCase for JavaScript files: `dataProcessor.js`
- Use SCREAMING_SNAKE_CASE for constants: `MAX_RETRY_ATTEMPTS`

### JavaScript Best Practices
```javascript
// Use strict mode
'use strict';

// Include proper error handling
try {
  // Your code here
} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}

// Use async/await for asynchronous operations
async function processData() {
  try {
    const result = await fetchData();
    return result;
  } catch (error) {
    throw new Error(`Failed to process data: ${error.message}`);
  }
}

// Include proper logging
console.log('🚀 Starting process...');
console.log('✅ Process completed successfully');
console.error('❌ Error occurred');
```

### Environment Variables
- Always use `.env.example` with placeholder values
- Never commit actual `.env` files
- Document all environment variables in README
- Use descriptive variable names

### Dependencies
- Pin specific versions in `package.json`
- Include only necessary dependencies
- Document why each dependency is needed
- Consider using native Node.js modules when possible

## 🔒 Security Guidelines

### Sensitive Data
- Never commit credentials, API keys, or secrets
- Use environment variables for sensitive configuration
- Add sensitive patterns to `.gitignore`
- Provide clear instructions for credential setup

### Input Validation
```javascript
// Validate input parameters
function validateInput(input) {
  if (!input || typeof input !== 'string') {
    throw new Error('Invalid input: expected non-empty string');
  }
  
  if (input.length > MAX_LENGTH) {
    throw new Error(`Input too long: maximum ${MAX_LENGTH} characters`);
  }
  
  return input.trim();
}
```

### Error Handling
- Always handle errors gracefully
- Provide meaningful error messages
- Use appropriate exit codes
- Log errors appropriately

## 🧪 Testing Requirements

### Basic Tests
Every script should include basic tests in `test.js`:

```javascript
#!/usr/bin/env node

const { main } = require('./index.js');

function runTests() {
  console.log('🧪 Running tests...');
  
  // Test 1: Basic functionality
  try {
    // Your test code here
    console.log('✅ Test 1 passed');
  } catch (error) {
    console.error('❌ Test 1 failed:', error.message);
    process.exit(1);
  }
  
  console.log('✅ All tests passed!');
}

if (require.main === module) {
  runTests();
}
```

### Test Categories
1. **Smoke Tests**: Basic functionality works
2. **Input Validation**: Handle invalid inputs gracefully
3. **Error Scenarios**: Proper error handling
4. **Edge Cases**: Boundary conditions and special cases

## 📊 Performance Guidelines

### For Data Processing Scripts
- Stream large files instead of loading entirely into memory
- Use batch processing for large datasets
- Implement progress indicators for long-running tasks
- Consider memory usage and optimize accordingly

### File Operations
```javascript
// Good: Streaming for large files
const fs = require('fs');
const readline = require('readline');

async function processLargeFile(filename) {
  const fileStream = fs.createReadStream(filename);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });
  
  for await (const line of rl) {
    // Process line by line
  }
}

// Avoid: Loading entire file into memory for large files
const data = fs.readFileSync('large-file.csv', 'utf8'); // Don't do this for large files
```

## 📦 Package.json Standards

Use this template for Node.js scripts:

```json
{
  "name": "script-name",
  "version": "1.0.0",
  "description": "Brief description",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "test": "node test.js"
  },
  "keywords": ["dev-toolbox", "utility", "specific-keywords"],
  "author": "Dev Team",
  "license": "ISC",
  "engines": {
    "node": ">=14.0.0"
  },
  "dependencies": {
    // Only production dependencies
  },
  "devDependencies": {
    // Development and testing dependencies
  }
}
```

## 🔄 Update Guidelines

### Updating the Main README
When adding a new script, update the main README.md:

1. Add entry to the "Available Scripts" table
2. Update the appropriate category section
3. Include the script in quick examples if relevant

### Versioning
- Use semantic versioning for major changes
- Update version in package.json
- Document breaking changes in README

## 🎯 Script Categories

### Data Analysis & Reporting
- CSV/JSON processing
- Log analysis
- Report generation
- Data transformation

### AWS Infrastructure Tools
- Resource management
- Monitoring and alerting
- Deployment automation
- Cost optimization

### Development Utilities
- Build automation
- Environment setup
- Testing helpers
- Code generation

## ✅ Pre-submission Checklist

Before submitting your script:

- [ ] README.md is complete and follows the template
- [ ] package.json includes all necessary information
- [ ] .env.example exists with placeholder values
- [ ] Script includes proper error handling
- [ ] Basic tests are implemented and pass
- [ ] Code follows the style guidelines
- [ ] No sensitive data is committed
- [ ] Dependencies are minimal and justified
- [ ] Script works on the target Node.js version
- [ ] Main README.md is updated with new script

## 🤝 Review Process

1. **Self-Review**: Use the checklist above
2. **Team Review**: Submit for peer review
3. **Testing**: Ensure scripts work in different environments
4. **Documentation**: Verify documentation is clear and complete

## 🆘 Getting Help

- Check existing scripts for examples
- Review this contributing guide
- Ask questions in team discussions
- Reach out to repository maintainers

---

**Thank you for contributing to the Dev Toolbox! 🎉**

Your contributions help the entire organization work more efficiently.
