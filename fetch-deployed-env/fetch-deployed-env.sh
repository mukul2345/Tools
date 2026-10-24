#!/bin/bash

# Check if the task definition name, output file, and optionally AWS profile are provided
if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: $0 <task-definition-name> <output-file> [aws-profile]"
  exit 1
fi

TASK_DEFINITION_NAME=$1
OUTPUT_FILE=$2
AWS_PROFILE=${3:-default}

# Fetch the task definition JSON
TASK_DEFINITION_JSON=$(aws ecs describe-task-definition --task-definition "$TASK_DEFINITION_NAME" --profile "$AWS_PROFILE")

# Extract environment variables and secrets
ENV_VARS=$(echo "$TASK_DEFINITION_JSON" | jq -r '.taskDefinition.containerDefinitions[].environment[] | "\(.name)=\(.value)"')
SECRETS=$(echo "$TASK_DEFINITION_JSON" | jq -r '.taskDefinition.containerDefinitions[].secrets[] | "\(.name)=\(.valueFrom)"')

# Write environment variables to the output file
echo "$ENV_VARS" > "$OUTPUT_FILE"

# Fetch and write secrets to the output file
for secret in $SECRETS; do
  
  NAME=$(echo "$secret" | cut -d'=' -f1)
  
  ARN=$(echo "$secret" | cut -d'=' -f2)
  
  SECRET_NAME=$(echo "$ARN" | sed 's/\(arn:aws:secretsmanager:[^:]*:[^:]*:secret:[^:]*\):.*/\1/')
 
  SECRET_VALUE=$(aws secretsmanager get-secret-value --secret-id "$SECRET_NAME" --query 'SecretString' --output text --profile "$AWS_PROFILE")
  
  # Extract the specific key from the secret value if it exists
  if [[ "$SECRET_VALUE" == *"$NAME"* ]]; then
    VALUE=$(echo "$SECRET_VALUE" | jq -r --arg key "$NAME" '.[$key]')
  else
    VALUE="$SECRET_VALUE"
  fi
  
  echo "$NAME=$VALUE" >> "$OUTPUT_FILE"
done

echo ".env file has been created successfully."