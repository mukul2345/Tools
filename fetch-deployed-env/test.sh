#!/bin/bash

# Test script for fetch-deployed-env
# Validates dependencies and basic functionality

echo "🧪 Testing fetch-deployed-env setup..."

# Test 1: Check if script exists and is executable
echo "📝 Test 1: Script existence and permissions..."
if [ -x "./fetch-deployed-env.sh" ]; then
    echo "✅ Script is executable"
else
    echo "❌ Script is not executable or doesn't exist"
    exit 1
fi

# Test 2: Check dependencies
echo "📝 Test 2: Checking dependencies..."

# Check AWS CLI
if command -v aws &> /dev/null; then
    echo "✅ AWS CLI is installed"
    aws --version
else
    echo "❌ AWS CLI is not installed"
    echo "   Install with: brew install awscli (macOS) or follow AWS documentation"
    exit 1
fi

# Check jq
if command -v jq &> /dev/null; then
    echo "✅ jq is installed"
    jq --version
else
    echo "❌ jq is not installed"
    echo "   Install with: brew install jq (macOS) or sudo apt-get install jq (Linux)"
    exit 1
fi

# Test 3: Check AWS CLI configuration
echo "📝 Test 3: AWS CLI configuration..."
if aws sts get-caller-identity &> /dev/null; then
    echo "✅ AWS CLI is configured and authenticated"
    aws sts get-caller-identity --output table
else
    echo "⚠️  AWS CLI is not configured or not authenticated"
    echo "   Run: aws configure"
    echo "   This test will continue, but the script won't work without AWS credentials"
fi

# Test 4: Script usage help
echo "📝 Test 4: Script help/usage..."
if ./fetch-deployed-env.sh 2>&1 | grep -q "Usage:"; then
    echo "✅ Script shows usage information correctly"
else
    echo "❌ Script doesn't show expected usage information"
    exit 1
fi

# Test 5: Validate README exists
echo "📝 Test 5: Documentation..."
if [ -f "README.md" ]; then
    echo "✅ README.md exists"
    echo "   Lines in README: $(wc -l < README.md)"
else
    echo "❌ README.md not found"
    exit 1
fi

# Test 6: Check .env.example
if [ -f ".env.example" ]; then
    echo "✅ .env.example exists"
else
    echo "❌ .env.example not found"
    exit 1
fi

echo ""
echo "🎉 All tests passed! fetch-deployed-env is ready to use."
echo ""
echo "📚 Next steps:"
echo "1. Configure AWS CLI: aws configure"
echo "2. Test with a real task definition:"
echo "   ./fetch-deployed-env.sh <task-definition-name> test.env"
echo "3. Check the generated test.env file"
echo ""
echo "📖 For detailed usage, see README.md"
