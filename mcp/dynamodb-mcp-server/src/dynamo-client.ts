import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getEnvironment } from './environments.js';

const clientCache = new Map<string, DynamoDBDocumentClient>();

export function getDocClient(env: string): DynamoDBDocumentClient {
  if (clientCache.has(env)) {
    return clientCache.get(env)!;
  }

  const config = getEnvironment(env);
  const baseClient = new DynamoDBClient({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  const docClient = DynamoDBDocumentClient.from(baseClient, {
    marshallOptions: {
      removeUndefinedValues: true,
    },
  });

  clientCache.set(env, docClient);
  return docClient;
}
