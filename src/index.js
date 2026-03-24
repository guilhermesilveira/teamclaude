#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AccountManager } from './account-manager.js';
import { createProxyServer } from './server.js';
import { importCredentials } from './oauth.js';

async function main() {
  const configPath = process.env.TEAMCLAUDE_CONFIG || resolve(process.cwd(), 'config.json');

  let config;
  try {
    config = JSON.parse(await readFile(configPath, 'utf-8'));
  } catch (err) {
    console.error(`[TeamClaude] Failed to load config from ${configPath}`);
    console.error(`  ${err.message}`);
    console.error('');
    console.error('Create a config.json based on config.example.json');
    process.exit(1);
  }

  if (!config.accounts?.length) {
    console.error('[TeamClaude] No accounts configured in config.json');
    process.exit(1);
  }

  // Initialize accounts
  const accounts = [];
  for (const acctConfig of config.accounts) {
    const account = { name: acctConfig.name, type: acctConfig.type };

    if (acctConfig.type === 'oauth') {
      if (acctConfig.importFrom) {
        try {
          const creds = await importCredentials(acctConfig.importFrom);
          account.accessToken = creds.accessToken;
          account.refreshToken = creds.refreshToken;
          account.expiresAt = creds.expiresAt;
          console.log(`[TeamClaude] Imported OAuth credentials for "${account.name}" from ${acctConfig.importFrom}`);
        } catch (err) {
          console.error(`[TeamClaude] Failed to import credentials for "${account.name}": ${err.message}`);
          continue;
        }
      } else {
        account.accessToken = acctConfig.accessToken;
        account.refreshToken = acctConfig.refreshToken;
        account.expiresAt = acctConfig.expiresAt;
      }

      if (!account.accessToken) {
        console.error(`[TeamClaude] No access token for OAuth account "${account.name}", skipping`);
        continue;
      }
    } else if (acctConfig.type === 'apikey') {
      account.apiKey = acctConfig.apiKey;
      if (!account.apiKey) {
        console.error(`[TeamClaude] No API key for account "${account.name}", skipping`);
        continue;
      }
    } else {
      console.error(`[TeamClaude] Unknown account type "${acctConfig.type}" for "${account.name}", skipping`);
      continue;
    }

    accounts.push(account);
  }

  if (accounts.length === 0) {
    console.error('[TeamClaude] No valid accounts initialized');
    process.exit(1);
  }

  // Create account manager and server
  const switchThreshold = config.switchThreshold || 0.98;
  const accountManager = new AccountManager(accounts, switchThreshold);
  const port = config.proxy?.port || 3456;
  const server = createProxyServer(accountManager, config);

  server.listen(port, () => {
    const sep = '='.repeat(60);
    console.log('');
    console.log(sep);
    console.log('  TeamClaude Proxy');
    console.log(sep);
    console.log(`  Port:       ${port}`);
    console.log(`  Accounts:   ${accounts.length}`);
    console.log(`  Threshold:  ${(switchThreshold * 100).toFixed(0)}%`);
    console.log(`  Upstream:   ${config.upstream || 'https://api.anthropic.com'}`);
    console.log('');
    accounts.forEach((a, i) => {
      console.log(`  [${i + 1}] ${a.name} (${a.type})`);
    });
    console.log('');
    console.log('  Usage:');
    console.log(`    ANTHROPIC_BASE_URL=http://localhost:${port} \\`);
    console.log(`    ANTHROPIC_API_KEY=${config.proxy?.apiKey || '<proxy-key>'} \\`);
    console.log('    claude');
    console.log('');
    console.log(`  Status: curl -H "x-api-key: <proxy-key>" http://localhost:${port}/teamclaude/status`);
    console.log(sep);
    console.log('');
  });

  process.on('SIGINT', () => {
    console.log('\n[TeamClaude] Shutting down...');
    server.close(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    console.log('\n[TeamClaude] Shutting down...');
    server.close(() => process.exit(0));
  });
}

main();
