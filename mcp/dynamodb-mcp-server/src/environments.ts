/**
 * Environment configuration for DynamoDB access.
 *
 * Credentials are read from a local `.env` file at the package root (or real
 * environment variables). This file contains NO secrets and is safe to commit
 * and share. Copy `.env.example` to `.env` and fill in your keys.
 */

import * as fs from 'fs';
import * as path from 'path';

// --- Minimal zero-dependency .env loader (package root: dist/../.env) ---
(function loadEnvFile() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const key = match[1];
      const value = match[2].trim().replace(/^["']|["']$/g, '');
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    /* no .env file — fall back to real environment variables */
  }
})();

export interface EnvironmentConfig {
  name: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  description: string;
}

export const environments: Record<string, EnvironmentConfig> = {
  staging: {
    name: 'staging',
    region: process.env.STAGING_AWS_REGION || 'ap-south-1',
    accessKeyId: process.env.STAGING_AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.STAGING_AWS_SECRET_ACCESS_KEY || '',
    description: 'Staging environment (ap-south-1, account 471112785275)',
  },
  develop: {
    name: 'develop',
    region: process.env.DEVELOP_AWS_REGION || 'ap-south-1',
    accessKeyId: process.env.DEVELOP_AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.DEVELOP_AWS_SECRET_ACCESS_KEY || '',
    description: 'Development environment (ap-south-1)',
  },
  preprod: {
    name: 'preprod',
    region: process.env.PREPROD_AWS_REGION || 'ap-south-1',
    accessKeyId: process.env.PREPROD_AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.PREPROD_AWS_SECRET_ACCESS_KEY || '',
    description: 'Pre-production environment (ap-south-1, account 058264398403)',
  },
  production: {
    name: 'production',
    // Prod infra runs in eu-west-1 (account 891377067284). Override via PROD_AWS_REGION if different.
    region: process.env.PROD_AWS_REGION || 'eu-west-1',
    accessKeyId: process.env.PROD_AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.PROD_AWS_SECRET_ACCESS_KEY || '',
    description: 'Production environment (account 891377067284, eu-west-1)',
  },
};

export function getEnvironment(env: string): EnvironmentConfig {
  const config = environments[env];
  if (!config) {
    throw new Error(
      `Unknown environment: "${env}". Available: ${Object.keys(environments).join(', ')}`
    );
  }
  if (!config.accessKeyId || !config.secretAccessKey) {
    throw new Error(
      `Credentials not configured for environment "${env}". Add them to .env (see .env.example) or set env vars.`
    );
  }
  return config;
}
