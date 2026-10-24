#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  ListTablesCommand,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb';
import {
  ScanCommand,
  QueryCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { getDocClient } from './dynamo-client.js';
import { getEnvironment, environments } from './environments.js';

const server = new McpServer({
  name: 'dynamodb-mcp-server',
  version: '1.0.0',
});

// ============================================================
// Table schema cache + access-pattern helpers
// ------------------------------------------------------------
// Knowing each table's key structure lets us build Query calls
// (on the partition key / a GSI) instead of expensive full-table Scans.
// ============================================================

interface KeyPair {
  partitionKey: string;
  sortKey?: string;
}
interface IndexKey extends KeyPair {
  indexName: string;
}
interface TableSchema {
  tableName: string;
  main: KeyPair;
  gsis: IndexKey[];
  lsis: IndexKey[];
  attributeTypes: Record<string, string>; // key attribute name -> S | N | B
}

const schemaCache = new Map<string, TableSchema>();

function rawClient(environment: string): DynamoDBClient {
  const config = getEnvironment(environment);
  return new DynamoDBClient({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

function keyPairFrom(keySchema?: Array<{ AttributeName?: string; KeyType?: string }>): KeyPair {
  const partitionKey = keySchema?.find((k) => k.KeyType === 'HASH')?.AttributeName || '';
  const sortKey = keySchema?.find((k) => k.KeyType === 'RANGE')?.AttributeName;
  return { partitionKey, sortKey };
}

function schemaFromTable(table: any, fallbackName: string): TableSchema {
  const attributeTypes: Record<string, string> = {};
  for (const def of table?.AttributeDefinitions || []) {
    if (def.AttributeName && def.AttributeType) attributeTypes[def.AttributeName] = def.AttributeType;
  }
  return {
    tableName: table?.TableName || fallbackName,
    main: keyPairFrom(table?.KeySchema),
    gsis: (table?.GlobalSecondaryIndexes || []).map((g: any) => ({ indexName: g.IndexName || '', ...keyPairFrom(g.KeySchema) })),
    lsis: (table?.LocalSecondaryIndexes || []).map((l: any) => ({ indexName: l.IndexName || '', ...keyPairFrom(l.KeySchema) })),
    attributeTypes,
  };
}

async function getTableSchema(environment: string, tableName: string): Promise<TableSchema> {
  const cacheKey = `${environment}::${tableName}`;
  const cached = schemaCache.get(cacheKey);
  if (cached) return cached;

  const response = await rawClient(environment).send(new DescribeTableCommand({ TableName: tableName }));
  const schema = schemaFromTable(response.Table, tableName);
  schemaCache.set(cacheKey, schema);
  return schema;
}

/** Derive the queryable access patterns (which attributes can be used in a Query, and via what index). */
function deriveAccessPatterns(schema: TableSchema) {
  const patterns = [
    { target: 'MAIN_TABLE', indexName: null as string | null, partitionKey: schema.main.partitionKey, sortKey: schema.main.sortKey || null },
    ...schema.gsis.map((g) => ({ target: 'GSI', indexName: g.indexName, partitionKey: g.partitionKey, sortKey: g.sortKey || null })),
    ...schema.lsis.map((l) => ({ target: 'LSI', indexName: l.indexName, partitionKey: l.partitionKey, sortKey: l.sortKey || null })),
  ];
  const queryableAttributes = Array.from(new Set(patterns.map((p) => p.partitionKey).filter(Boolean)));
  return { patterns, queryableAttributes };
}

function namePlaceholder(attr: string): string {
  return `#${attr.replace(/[^a-zA-Z0-9]/g, '_')}`;
}
function valuePlaceholder(attr: string): string {
  return `:${attr.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

// Tool: List available environments
server.tool(
  'list_environments',
  'List all configured DynamoDB environments (develop, staging, production)',
  {},
  async () => {
    const envList = Object.entries(environments).map(([key, config]) => ({
      name: key,
      region: config.region,
      description: config.description,
      hasCredentials: Boolean(config.accessKeyId && config.secretAccessKey),
    }));
    return {
      content: [{ type: 'text', text: JSON.stringify(envList, null, 2) }],
    };
  }
);

// Tool: List tables
server.tool(
  'list_tables',
  'List DynamoDB tables in the specified environment. Optionally filter by name pattern.',
  {
    environment: z.string().describe('Environment name: develop, staging, or production'),
    nameFilter: z.string().optional().describe('Optional substring to filter table names (case-insensitive)'),
  },
  async ({ environment, nameFilter }) => {
    const config = getEnvironment(environment);
    const client = new DynamoDBClient({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });

    let allTables: string[] = [];
    let lastEvaluatedTableName: string | undefined;

    do {
      const command = new ListTablesCommand({
        ExclusiveStartTableName: lastEvaluatedTableName,
        Limit: 100,
      });
      const response = await client.send(command);
      allTables = allTables.concat(response.TableNames || []);
      lastEvaluatedTableName = response.LastEvaluatedTableName;
    } while (lastEvaluatedTableName);

    if (nameFilter) {
      const filter = nameFilter.toLowerCase();
      allTables = allTables.filter(t => t.toLowerCase().includes(filter));
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ environment, tableCount: allTables.length, tables: allTables }, null, 2),
      }],
    };
  }
);

// Tool: Describe table
server.tool(
  'describe_table',
  'Get table schema, indexes, and key information for a DynamoDB table',
  {
    environment: z.string().describe('Environment name: develop, staging, or production'),
    tableName: z.string().describe('DynamoDB table name'),
  },
  async ({ environment, tableName }) => {
    const config = getEnvironment(environment);
    const client = new DynamoDBClient({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });

    const command = new DescribeTableCommand({ TableName: tableName });
    const response = await client.send(command);
    const table = response.Table;

    // Cache the derived schema so query_by_attributes can plan queries cheaply.
    const schema = schemaFromTable(table, tableName);
    schemaCache.set(`${environment}::${tableName}`, schema);
    const { patterns, queryableAttributes } = deriveAccessPatterns(schema);

    const result = {
      tableName: table?.TableName,
      status: table?.TableStatus,
      itemCount: table?.ItemCount,
      keySchema: table?.KeySchema,
      attributeDefinitions: table?.AttributeDefinitions,
      globalSecondaryIndexes: table?.GlobalSecondaryIndexes?.map(gsi => ({
        indexName: gsi.IndexName,
        keySchema: gsi.KeySchema,
        projection: gsi.Projection,
      })),
      localSecondaryIndexes: table?.LocalSecondaryIndexes?.map(lsi => ({
        indexName: lsi.IndexName,
        keySchema: lsi.KeySchema,
        projection: lsi.Projection,
      })),
      // Derived guidance: query by any of these attributes (via the listed index) to avoid a full scan.
      accessPatterns: patterns,
      queryableAttributes,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Tool: Get item by ID
server.tool(
  'get_item',
  'Get a single item from a DynamoDB table by its primary key',
  {
    environment: z.string().describe('Environment name: develop, staging, or production'),
    tableName: z.string().describe('DynamoDB table name'),
    key: z.record(z.string(), z.any()).describe('Primary key as JSON object, e.g. {"id": "ClaimItem@abc123"}'),
    projectionExpression: z.string().optional().describe('Comma-separated list of attributes to return'),
  },
  async ({ environment, tableName, key, projectionExpression }) => {
    const docClient = getDocClient(environment);

    const params: any = {
      TableName: tableName,
      Key: key,
    };
    if (projectionExpression) {
      // Handle reserved words by using expression attribute names
      const attrs = projectionExpression.split(',').map(a => a.trim());
      const expressionAttributeNames: Record<string, string> = {};
      const projParts: string[] = [];
      for (const attr of attrs) {
        const placeholder = `#${attr.replace(/[^a-zA-Z0-9]/g, '_')}`;
        expressionAttributeNames[placeholder] = attr;
        projParts.push(placeholder);
      }
      params.ProjectionExpression = projParts.join(', ');
      params.ExpressionAttributeNames = expressionAttributeNames;
    }

    const command = new GetCommand(params);
    const response = await docClient.send(command);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ item: response.Item || null }, null, 2),
      }],
    };
  }
);

// Tool: Query table (using index)
server.tool(
  'query_table',
  'Query a DynamoDB table or GSI using key condition expressions. Use this when you know the partition key value.',
  {
    environment: z.string().describe('Environment name: develop, staging, or production'),
    tableName: z.string().describe('DynamoDB table name'),
    indexName: z.string().optional().describe('GSI name to query (omit to query the main table)'),
    keyCondition: z.string().describe('Key condition expression, e.g. "verificationRequestId = :vrId"'),
    expressionValues: z.record(z.string(), z.any()).describe('Expression attribute values as JSON, e.g. {":vrId": "VerificationRequest@abc"}'),
    filterExpression: z.string().optional().describe('Optional filter expression to apply after query'),
    projectionExpression: z.string().optional().describe('Comma-separated attributes to return'),
    limit: z.number().optional().describe('Max items to return (default 20)'),
    scanForward: z.boolean().optional().describe('Sort ascending (true) or descending (false). Default true.'),
  },
  async ({ environment, tableName, indexName, keyCondition, expressionValues, filterExpression, projectionExpression, limit, scanForward }) => {
    const docClient = getDocClient(environment);

    const params: any = {
      TableName: tableName,
      KeyConditionExpression: keyCondition,
      ExpressionAttributeValues: expressionValues,
      Limit: limit || 20,
      ScanIndexForward: scanForward !== false,
    };
    if (indexName) params.IndexName = indexName;
    if (filterExpression) params.FilterExpression = filterExpression;

    if (projectionExpression) {
      const attrs = projectionExpression.split(',').map(a => a.trim());
      const expressionAttributeNames: Record<string, string> = params.ExpressionAttributeNames || {};
      const projParts: string[] = [];
      for (const attr of attrs) {
        const placeholder = `#${attr.replace(/[^a-zA-Z0-9]/g, '_')}`;
        expressionAttributeNames[placeholder] = attr;
        projParts.push(placeholder);
      }
      params.ProjectionExpression = projParts.join(', ');
      params.ExpressionAttributeNames = expressionAttributeNames;
    }

    const command = new QueryCommand(params);
    const response = await docClient.send(command);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          count: response.Count,
          scannedCount: response.ScannedCount,
          items: response.Items || [],
          hasMore: Boolean(response.LastEvaluatedKey),
        }, null, 2),
      }],
    };
  }
);

// Tool: Scan table
server.tool(
  'scan_table',
  'Scan a DynamoDB table with optional filter expressions. Use sparingly on large tables — prefer query_table when possible.',
  {
    environment: z.string().describe('Environment name: develop, staging, or production'),
    tableName: z.string().describe('DynamoDB table name'),
    filterExpression: z.string().optional().describe('Filter expression, e.g. "#s = :state"'),
    expressionAttributeNames: z.record(z.string(), z.string()).optional().describe('Attribute name placeholders, e.g. {"#s": "state"}'),
    expressionValues: z.record(z.string(), z.any()).optional().describe('Expression attribute values, e.g. {":state": "RE_VERIFICATION"}'),
    projectionExpression: z.string().optional().describe('Comma-separated attributes to return'),
    limit: z.number().optional().describe('Max items to return (default 20). Note: this is items evaluated, not matched.'),
    maxResults: z.number().optional().describe('Stop after finding this many matching items (default 10). Handles pagination internally.'),
  },
  async ({ environment, tableName, filterExpression, expressionAttributeNames, expressionValues, projectionExpression, limit, maxResults }) => {
    const docClient = getDocClient(environment);
    const targetResults = maxResults || 10;
    let allItems: any[] = [];
    let lastEvaluatedKey: any = undefined;
    let totalScanned = 0;
    const maxScanPages = 50; // Safety limit to prevent runaway scans
    let pages = 0;

    do {
      const params: any = {
        TableName: tableName,
        Limit: limit || 100,
      };
      if (filterExpression) params.FilterExpression = filterExpression;
      if (expressionValues) params.ExpressionAttributeValues = expressionValues;
      if (lastEvaluatedKey) params.ExclusiveStartKey = lastEvaluatedKey;

      // Merge expression attribute names from filter and projection
      const mergedNames: Record<string, string> = { ...((expressionAttributeNames || {}) as Record<string, string>) };

      if (projectionExpression) {
        const attrs = projectionExpression.split(',').map(a => a.trim());
        const projParts: string[] = [];
        for (const attr of attrs) {
          const placeholder = `#${attr.replace(/[^a-zA-Z0-9]/g, '_')}`;
          mergedNames[placeholder] = attr;
          projParts.push(placeholder);
        }
        params.ProjectionExpression = projParts.join(', ');
      }

      if (Object.keys(mergedNames).length > 0) {
        params.ExpressionAttributeNames = mergedNames;
      }

      const command = new ScanCommand(params);
      const response = await docClient.send(command);

      allItems = allItems.concat(response.Items || []);
      totalScanned += response.ScannedCount || 0;
      lastEvaluatedKey = response.LastEvaluatedKey;
      pages++;
    } while (lastEvaluatedKey && allItems.length < targetResults && pages < maxScanPages);

    // Trim to maxResults
    const resultItems = allItems.slice(0, targetResults);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          count: resultItems.length,
          totalScanned,
          items: resultItems,
          hasMore: Boolean(lastEvaluatedKey) || allItems.length > targetResults,
          pagesScanned: pages,
        }, null, 2),
      }],
    };
  }
);

// Tool: Query by attributes (schema-aware, avoids scans)
server.tool(
  'query_by_attributes',
  'Fetch items by attribute equality WITHOUT scanning. Inspects the table schema (partition/sort keys + GSIs/LSIs) and automatically routes to a Query on the main table or the best-matching index. Any provided attributes that are not part of the chosen key become a post-query filter. Refuses to scan unless allowScan=true. Prefer this over scan_table.',
  {
    environment: z.string().describe('Environment name: develop, staging, preprod, or production'),
    tableName: z.string().describe('DynamoDB table name'),
    attributes: z.record(z.string(), z.any()).describe('Equality match map, e.g. {"verificationRequestId":"VerificationRequest@abc","status":"ACTIVE"}. At least one must be a partition key (see describe_table.queryableAttributes).'),
    limit: z.number().optional().describe('Max items to return (default 20)'),
    scanForward: z.boolean().optional().describe('Sort ascending (true) or descending (false). Default true.'),
    projectionExpression: z.string().optional().describe('Comma-separated attributes to return'),
    allowScan: z.boolean().optional().describe('If no key/index matches the provided attributes, allow a filtered scan fallback (default false).'),
  },
  async ({ environment, tableName, attributes, limit, scanForward, projectionExpression, allowScan }) => {
    const schema = await getTableSchema(environment, tableName);
    const provided = Object.keys(attributes);
    const docClient = getDocClient(environment);

    // Candidate access paths whose partition key is among the provided attributes.
    // Preference order: main table, then GSIs, then LSIs; bonus if the sort key is also provided.
    const candidates = [
      { target: 'MAIN_TABLE', indexName: undefined as string | undefined, partitionKey: schema.main.partitionKey, sortKey: schema.main.sortKey },
      ...schema.gsis.map((g) => ({ target: 'GSI', indexName: g.indexName as string | undefined, partitionKey: g.partitionKey, sortKey: g.sortKey })),
      ...schema.lsis.map((l) => ({ target: 'LSI', indexName: l.indexName as string | undefined, partitionKey: l.partitionKey, sortKey: l.sortKey })),
    ].filter((c) => c.partitionKey && provided.includes(c.partitionKey));

    candidates.sort((a, b) => {
      const aSk = a.sortKey && provided.includes(a.sortKey) ? 1 : 0;
      const bSk = b.sortKey && provided.includes(b.sortKey) ? 1 : 0;
      return bSk - aSk;
    });

    const chosen = candidates[0];

    // No queryable path — do not silently scan.
    if (!chosen) {
      const ap = deriveAccessPatterns(schema);
      if (!allowScan) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'NO_QUERYABLE_KEY',
              message: `None of [${provided.join(', ')}] is a partition key on "${tableName}", so a Query is not possible. A Scan would be required — re-run with allowScan=true to scan, or query using one of the queryableAttributes below.`,
              queryableAttributes: ap.queryableAttributes,
              accessPatterns: ap.patterns,
            }, null, 2),
          }],
        };
      }

      // Explicit scan fallback with equality filters on all provided attributes.
      const names: Record<string, string> = {};
      const values: Record<string, any> = {};
      const filterParts: string[] = [];
      for (const [k, v] of Object.entries(attributes)) {
        names[namePlaceholder(k)] = k;
        values[valuePlaceholder(k)] = v;
        filterParts.push(`${namePlaceholder(k)} = ${valuePlaceholder(k)}`);
      }
      const scanParams: any = {
        TableName: tableName,
        FilterExpression: filterParts.join(' AND '),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        Limit: limit || 100,
      };
      const scanResp = await docClient.send(new ScanCommand(scanParams));
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            accessPath: 'SCAN (fallback — allowScan=true)',
            count: scanResp.Count,
            scannedCount: scanResp.ScannedCount,
            items: scanResp.Items || [],
            hasMore: Boolean(scanResp.LastEvaluatedKey),
          }, null, 2),
        }],
      };
    }

    // Build the Query on the chosen key/index.
    const names: Record<string, string> = {};
    const values: Record<string, any> = {};
    const keyParts: string[] = [];
    const usedKeys = new Set<string>();

    const pk = chosen.partitionKey;
    names[namePlaceholder(pk)] = pk;
    values[valuePlaceholder(pk)] = attributes[pk];
    keyParts.push(`${namePlaceholder(pk)} = ${valuePlaceholder(pk)}`);
    usedKeys.add(pk);

    if (chosen.sortKey && provided.includes(chosen.sortKey)) {
      const sk = chosen.sortKey;
      names[namePlaceholder(sk)] = sk;
      values[valuePlaceholder(sk)] = attributes[sk];
      keyParts.push(`${namePlaceholder(sk)} = ${valuePlaceholder(sk)}`);
      usedKeys.add(sk);
    }

    // Remaining provided attributes become a post-query filter.
    const filterParts: string[] = [];
    for (const [k, v] of Object.entries(attributes)) {
      if (usedKeys.has(k)) continue;
      names[namePlaceholder(k)] = k;
      values[valuePlaceholder(k)] = v;
      filterParts.push(`${namePlaceholder(k)} = ${valuePlaceholder(k)}`);
    }

    const params: any = {
      TableName: tableName,
      KeyConditionExpression: keyParts.join(' AND '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      Limit: limit || 20,
      ScanIndexForward: scanForward !== false,
    };
    if (chosen.indexName) params.IndexName = chosen.indexName;
    if (filterParts.length > 0) params.FilterExpression = filterParts.join(' AND ');

    if (projectionExpression) {
      const projParts: string[] = [];
      for (const attr of projectionExpression.split(',').map((a) => a.trim())) {
        names[namePlaceholder(attr)] = attr;
        projParts.push(namePlaceholder(attr));
      }
      params.ProjectionExpression = projParts.join(', ');
    }

    const response = await docClient.send(new QueryCommand(params));
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          accessPath: chosen.indexName ? `${chosen.target}: ${chosen.indexName}` : 'MAIN_TABLE',
          partitionKey: pk,
          sortKeyUsed: usedKeys.has(chosen.sortKey || '') ? chosen.sortKey : null,
          filteredAttributes: filterParts.length > 0 ? Object.keys(attributes).filter((k) => !usedKeys.has(k)) : [],
          count: response.Count,
          scannedCount: response.ScannedCount,
          items: response.Items || [],
          hasMore: Boolean(response.LastEvaluatedKey),
        }, null, 2),
      }],
    };
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
