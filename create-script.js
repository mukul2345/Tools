#!/usr/bin/env node

/**
 * Dev Toolbox Script Generator
 *
 * A helper script to create new script folders with proper structure
 * Usage: node create-script.js <script-name> [description]
 */

const fs = require("fs");
const path = require("path");

function createScript(
  scriptName,
  description = "A new development utility script"
) {
  const scriptDir = path.join(__dirname, scriptName);

  // Check if directory already exists
  if (fs.existsSync(scriptDir)) {
    console.error(`❌ Directory '${scriptName}' already exists!`);
    process.exit(1);
  }

  // Create directory
  fs.mkdirSync(scriptDir, { recursive: true });
  console.log(`📁 Created directory: ${scriptName}/`);

  // Create package.json
  const packageJson = {
    name: scriptName,
    version: "1.0.0",
    description: description,
    main: "index.js",
    scripts: {
      start: "node index.js",
      test: "node test.js",
    },
    keywords: ["dev-toolbox", "utility"],
    author: "Dev Team",
    license: "ISC",
    engines: {
      node: ">=14.0.0",
    },
  };

  fs.writeFileSync(
    path.join(scriptDir, "package.json"),
    JSON.stringify(packageJson, null, 2)
  );
  console.log(`📦 Created package.json`);

  // Create README.md template
  const readmeContent = `# ${scriptName
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")}

${description}

## 🎯 Purpose

Describe the main purpose and use cases of this script.

## 🚀 Quick Start

### Prerequisites
- Node.js (v14 or higher)
- [List any other requirements]

### Installation
\`\`\`bash
cd ${scriptName}
npm install
\`\`\`

### Usage
\`\`\`bash
npm start
# or
node index.js
\`\`\`

## 📝 Configuration

### Environment Variables
Copy the example environment file:
\`\`\`bash
cp .env.example .env
\`\`\`

Configure the following variables in \`.env\`:
\`\`\`env
# Add your environment variables here
\`\`\`

## 📊 Examples

Add usage examples here.

## 🔧 Options

Document any command-line options or configuration parameters.

## 📁 Output

Describe what files or outputs this script generates.

## 🐛 Troubleshooting

### Common Issues
1. **Issue 1**: Description and solution
2. **Issue 2**: Description and solution

## 🤝 Contributing

Instructions for extending or modifying this script.

---

**Part of the [Dev Toolbox](../) collection**
`;

  fs.writeFileSync(path.join(scriptDir, "README.md"), readmeContent);
  console.log(`📖 Created README.md`);

  // Create .env.example
  const envExample = `# ${scriptName
    .toUpperCase()
    .replace(/-/g, "_")} Configuration
# Copy this file to .env and configure as needed

# Example configuration
# DEBUG_MODE=false
# LOG_LEVEL=info
`;

  fs.writeFileSync(path.join(scriptDir, ".env.example"), envExample);
  console.log(`⚙️  Created .env.example`);

  // Create basic index.js
  const indexJs = `#!/usr/bin/env node

/**
 * ${scriptName
   .split("-")
   .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
   .join(" ")}
 * 
 * ${description}
 */

const fs = require('fs');
const path = require('path');

// Load environment variables if .env file exists
if (fs.existsSync('.env')) {
  require('dotenv').config();
}

function main() {
  console.log('🚀 Starting ${scriptName}...');
  
  try {
    // Add your main script logic here
    console.log('✅ Script completed successfully!');
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Run the script if called directly
if (require.main === module) {
  main();
}

module.exports = { main };
`;

  fs.writeFileSync(path.join(scriptDir, "index.js"), indexJs);
  console.log(`📝 Created index.js`);

  // Create basic test.js
  const testJs = `#!/usr/bin/env node

/**
 * Test suite for ${scriptName}
 */

const { main } = require('./index.js');

function runTests() {
  console.log('🧪 Running tests for ${scriptName}...');
  
  try {
    // Add your tests here
    console.log('✅ All tests passed!');
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  runTests();
}
`;

  fs.writeFileSync(path.join(scriptDir, "test.js"), testJs);
  console.log(`🧪 Created test.js`);

  console.log(`\n🎉 Successfully created script: ${scriptName}`);
  console.log(`\nNext steps:`);
  console.log(`1. cd ${scriptName}`);
  console.log(`2. npm install`);
  console.log(`3. Edit index.js with your script logic`);
  console.log(`4. Update README.md with specific documentation`);
  console.log(`5. Configure .env file if needed`);
  console.log(
    `\n📚 Don't forget to update the main README.md with your new script!`
  );
}

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length === 0) {
  console.log("Usage: node create-script.js <script-name> [description]");
  console.log(
    'Example: node create-script.js data-processor "Process and analyze data files"'
  );
  process.exit(1);
}

const scriptName = args[0];
const description = args[1] || "A new development utility script";

createScript(scriptName, description);
