#!/usr/bin/env ts-node

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import {
  CallExpression,
  NewExpression,
  Node,
  ObjectLiteralExpression,
  Project,
  PropertyAssignment,
  ShorthandPropertyAssignment,
  SourceFile,
  SyntaxKind,
} from "ts-morph";

/** CallExpression and NewExpression both have getExpression() and getArguments(). */
type CallLikeExpression = CallExpression | NewExpression;

type ResourceType = "sqs" | "dynamodb" | "lambda" | "sns";

type ServiceResources = {
  sqs: string[];
  dynamodb: string[];
  lambda: string[];
  sns: string[];
};

type OutputJson = {
  rootPath: string;
  generatedAt: string;
  services: Record<string, ServiceResources>;
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function isIgnoredPath(filePath: string): boolean {
  const normalized = normalizeSlashes(filePath);
  return (
    normalized.includes("/node_modules/") ||
    normalized.includes("/.git/") ||
    normalized.includes("/dist/") ||
    normalized.includes("/build/") ||
    normalized.includes("/cdk.out/")
  );
}

function createEmptyResources(): ServiceResources {
  return {
    sqs: [],
    dynamodb: [],
    lambda: [],
    sns: [],
  };
}

function addUnique(target: string[], value: string): void {
  if (!value) return;
  if (!target.includes(value)) {
    target.push(value);
  }
}

function getPropertyByName(
  obj: ObjectLiteralExpression,
  propertyName: string,
): Node | undefined {
  return obj.getProperties().find((prop) => {
    if (
      Node.isPropertyAssignment(prop) ||
      Node.isShorthandPropertyAssignment(prop)
    ) {
      return prop.getName() === propertyName;
    }
    return false;
  });
}

function getLiteralStringFromNode(node: Node | undefined): string | undefined {
  if (!node) return undefined;

  if (Node.isPropertyAssignment(node)) {
    return getLiteralStringFromExpression(node.getInitializer());
  }

  if (Node.isShorthandPropertyAssignment(node)) {
    return node.getName();
  }

  return undefined;
}

function getLiteralStringFromExpression(
  expr: Node | undefined,
): string | undefined {
  if (!expr) return undefined;

  if (
    Node.isStringLiteral(expr) ||
    Node.isNoSubstitutionTemplateLiteral(expr)
  ) {
    return expr.getLiteralValue();
  }

  if (Node.isTemplateExpression(expr)) {
    const head = expr.getHead().getLiteralText();
    const spans = expr.getTemplateSpans();

    // Only resolve fully static templates like `abc`
    if (spans.length === 0) {
      return head;
    }

    // Dynamic template, skip
    return undefined;
  }

  return undefined;
}

function getObjectLiteralArgument(
  callExpr: CallLikeExpression,
): ObjectLiteralExpression | undefined {
  for (const arg of callExpr.getArguments()) {
    if (Node.isObjectLiteralExpression(arg)) {
      return arg;
    }
  }
  return undefined;
}

function getConstructName(callExpr: CallLikeExpression): string {
  return callExpr.getExpression().getText();
}

function isTargetConstruct(constructName: string): boolean {
  return (
    constructName === "DFGQueue" ||
    constructName.endsWith(".DFGQueue") ||
    constructName === "DFGDynamo.DFGDynamoTable" ||
    constructName.endsWith(".DFGDynamoTable") ||
    constructName === "DFGLambda" ||
    constructName.endsWith(".DFGLambda") ||
    constructName === "DFGSnsTopic" ||
    constructName.endsWith(".DFGSnsTopic")
  );
}

function detectResourceType(constructName: string): ResourceType | undefined {
  if (constructName === "DFGQueue" || constructName.endsWith(".DFGQueue")) {
    return "sqs";
  }

  if (
    constructName === "DFGDynamo.DFGDynamoTable" ||
    constructName.endsWith(".DFGDynamoTable")
  ) {
    return "dynamodb";
  }

  if (constructName === "DFGLambda" || constructName.endsWith(".DFGLambda")) {
    return "lambda";
  }

  if (
    constructName === "DFGSnsTopic" ||
    constructName.endsWith(".DFGSnsTopic")
  ) {
    return "sns";
  }

  return undefined;
}

function getResourceName(
  resourceType: ResourceType,
  obj: ObjectLiteralExpression,
): string | undefined {
  switch (resourceType) {
    case "sqs":
      return getLiteralStringFromNode(getPropertyByName(obj, "name"));

    case "dynamodb":
      return getLiteralStringFromNode(getPropertyByName(obj, "tableName"));

    case "lambda":
      return getLiteralStringFromNode(getPropertyByName(obj, "name"));

    case "sns":
      return getLiteralStringFromNode(getPropertyByName(obj, "topicName"));

    default:
      return undefined;
  }
}

function findCdkFiles(servicePath: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const normalized = normalizeSlashes(fullPath);

      if (isIgnoredPath(normalized)) {
        continue;
      }

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (
        entry.isFile() &&
        (normalized.endsWith("/bin/cdk.ts") ||
          normalized.endsWith("/bin/cdk.tsx"))
      ) {
        results.push(fullPath);
      }
    }
  }

  walk(servicePath);
  return results;
}

function scanSourceFile(
  sourceFile: SourceFile,
  resources: ServiceResources,
): void {
  const newExpressions = sourceFile.getDescendantsOfKind(
    SyntaxKind.NewExpression,
  );

  for (const newExpr of newExpressions) {
    const constructName = getConstructName(newExpr);
    if (!isTargetConstruct(constructName)) {
      continue;
    }

    const resourceType = detectResourceType(constructName);
    if (!resourceType) {
      continue;
    }

    const obj = getObjectLiteralArgument(newExpr);
    if (!obj) {
      continue;
    }

    const resourceName = getResourceName(resourceType, obj);
    if (!resourceName) {
      continue;
    }

    addUnique(resources[resourceType], resourceName);
  }
}

async function main(): Promise<void> {
  const rootPathInput = (await ask("Enter absolute root folder path: ")).trim();
  const rootPath = path.resolve(rootPathInput);

  if (
    !path.isAbsolute(rootPathInput) ||
    !fs.existsSync(rootPath) ||
    !fs.statSync(rootPath).isDirectory()
  ) {
    console.error("Invalid absolute root folder path");
    process.exit(1);
  }

  const defaultServiceNames = [
    "verification-workflow-engine",
    "poi-service",
    "verification-request",
    "verification-initiation-service",
    "document-management-service",
    "document-generation-service",
    "client-contract-service",
    "document-service",
    "core-verification-data-structure-service",
    "payment-service",
    "alert-service",
    "migration-service",
    "narada",
  ];
  const serviceNamesInput = (
    await ask("Enter service folder names (comma or space separated): ")
  ).trim();

  const serviceNames = serviceNamesInput
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  serviceNames.push(...defaultServiceNames);
  if (serviceNames.length === 0) {
    console.error("No service folder names provided");
    process.exit(1);
  }

  const outputFileInput = (
    await ask(
      "Enter output JSON file path [default: ./resource-inventory.json]: ",
    )
  ).trim();

  rl.close();

  const outputFile = outputFileInput
    ? path.resolve(outputFileInput)
    : path.resolve(process.cwd(), "resource-inventory.json");

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
  });

  const output: OutputJson = {
    rootPath,
    generatedAt: new Date().toISOString(),
    services: {},
  };

  for (const serviceName of serviceNames) {
    const servicePath = path.join(rootPath, serviceName);
    const resources = createEmptyResources();
    output.services[serviceName] = resources;

    if (
      !fs.existsSync(servicePath) ||
      !fs.statSync(servicePath).isDirectory()
    ) {
      console.warn(`Skipping missing service folder: ${serviceName}`);
      continue;
    }

    const cdkFiles = findCdkFiles(servicePath);

    for (const filePath of cdkFiles) {
      try {
        const sourceFile = project.addSourceFileAtPathIfExists(filePath);
        if (!sourceFile) continue;
        scanSourceFile(sourceFile, resources);
      } catch (error) {
        console.warn(
          `Failed to parse ${filePath}: ${(error as Error).message}`,
        );
      }
    }

    resources.sqs.sort();
    resources.dynamodb.sort();
    resources.lambda.sort();
    resources.sns.sort();
  }

  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2), "utf8");
  console.log(`Resource inventory written to: ${outputFile}`);
}

main().catch((error) => {
  rl.close();
  console.error(error);
  process.exit(1);
});
