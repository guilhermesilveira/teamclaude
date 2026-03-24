import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

/**
 * Import OAuth credentials from a Claude Code credentials file.
 */
export async function importCredentials(filePath) {
  const resolvedPath = filePath.replace(/^~/, homedir());
  const raw = JSON.parse(await readFile(resolvedPath, 'utf-8'));

  // Claude Code stores credentials nested under "claudeAiOauth"
  const data = raw.claudeAiOauth || raw;
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: data.expiresAt,
    subscriptionType: data.subscriptionType,
    rateLimitTier: data.rateLimitTier,
  };
}

const DEFAULT_OAUTH_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token';

/**
 * Refresh an expired OAuth access token using the refresh token.
 */
export async function refreshAccessToken(refreshToken, endpoint = DEFAULT_OAUTH_ENDPOINT) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'claude-code',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: data.expires_at || (Date.now() + (data.expires_in || 3600) * 1000),
  };
}

/**
 * Check if an OAuth token is expiring within the given threshold.
 */
export function isTokenExpiringSoon(expiresAt, thresholdMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  return Date.now() + thresholdMs >= expiresAt;
}
