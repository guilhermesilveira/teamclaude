import { refreshAccessToken, isTokenExpiringSoon } from './oauth.js';

export class AccountManager {
  constructor(accounts, switchThreshold = 0.98) {
    this.accounts = accounts.map((acct, index) => ({
      index,
      name: acct.name,
      type: acct.type,
      credential: acct.accessToken || acct.apiKey,
      refreshToken: acct.refreshToken || null,
      expiresAt: acct.expiresAt || null,
      status: 'active',
      quota: {
        tokensLimit: null,
        tokensRemaining: null,
        requestsLimit: null,
        requestsRemaining: null,
        resetsAt: null,
      },
      usage: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalRequests: 0,
        lastUsed: null,
      },
      rateLimitedUntil: null,
    }));
    this.currentIndex = 0;
    this.switchThreshold = switchThreshold;
  }

  /**
   * Get the best available account, rotating if the current one is near quota.
   * Returns null if all accounts are exhausted.
   */
  getActiveAccount() {
    const current = this.accounts[this.currentIndex];
    if (this._isAvailable(current)) {
      return current;
    }
    return this._selectNext();
  }

  _isAvailable(account) {
    if (!account) return false;

    // Check rate limit expiry
    if (account.status === 'throttled' && account.rateLimitedUntil) {
      if (Date.now() < account.rateLimitedUntil) return false;
      account.status = 'active';
      account.rateLimitedUntil = null;
      // Reset quota info since the rate limit window has passed
      account.quota.tokensRemaining = null;
      account.quota.requestsRemaining = null;
      console.log(`[TeamClaude] Account "${account.name}" rate limit expired, marking active`);
    }

    if (account.status === 'exhausted' || account.status === 'error') return false;
    if (this._isNearQuota(account)) return false;

    return true;
  }

  _isNearQuota(account) {
    const q = account.quota;

    if (q.tokensLimit != null && q.tokensRemaining != null) {
      const used = 1 - (q.tokensRemaining / q.tokensLimit);
      if (used >= this.switchThreshold) return true;
    }

    if (q.requestsLimit != null && q.requestsRemaining != null) {
      const used = 1 - (q.requestsRemaining / q.requestsLimit);
      if (used >= this.switchThreshold) return true;
    }

    return false;
  }

  _selectNext() {
    const startIndex = this.currentIndex;

    // Try each account in order
    for (let i = 1; i <= this.accounts.length; i++) {
      const idx = (startIndex + i) % this.accounts.length;
      const account = this.accounts[idx];

      if (this._isAvailable(account)) {
        this.currentIndex = idx;
        console.log(`[TeamClaude] Switched to account "${account.name}"`);
        return account;
      }
    }

    // All accounts unavailable — find the one that resets soonest
    let soonestAccount = null;
    let soonestTime = Infinity;

    for (const account of this.accounts) {
      const resetTime = account.rateLimitedUntil
        || (account.quota.resetsAt ? new Date(account.quota.resetsAt).getTime() : null);

      if (resetTime && resetTime < soonestTime) {
        soonestTime = resetTime;
        soonestAccount = account;
      }
    }

    // If the soonest reset is already in the past, use that account
    if (soonestAccount && soonestTime <= Date.now()) {
      soonestAccount.status = 'active';
      soonestAccount.rateLimitedUntil = null;
      soonestAccount.quota.tokensRemaining = null;
      soonestAccount.quota.requestsRemaining = null;
      this.currentIndex = soonestAccount.index;
      console.log(`[TeamClaude] Account "${soonestAccount.name}" reset, switching to it`);
      return soonestAccount;
    }

    return null;
  }

  /**
   * Update an account's quota tracking from upstream response headers.
   */
  updateQuota(accountIndex, headers) {
    const account = this.accounts[accountIndex];
    if (!account) return;

    const tokensLimit = parseInt(headers['anthropic-ratelimit-tokens-limit'], 10);
    const tokensRemaining = parseInt(headers['anthropic-ratelimit-tokens-remaining'], 10);
    const tokensReset = headers['anthropic-ratelimit-tokens-reset'];
    const requestsLimit = parseInt(headers['anthropic-ratelimit-requests-limit'], 10);
    const requestsRemaining = parseInt(headers['anthropic-ratelimit-requests-remaining'], 10);
    const requestsReset = headers['anthropic-ratelimit-requests-reset'];

    if (!isNaN(tokensLimit)) account.quota.tokensLimit = tokensLimit;
    if (!isNaN(tokensRemaining)) account.quota.tokensRemaining = tokensRemaining;
    if (!isNaN(requestsLimit)) account.quota.requestsLimit = requestsLimit;
    if (!isNaN(requestsRemaining)) account.quota.requestsRemaining = requestsRemaining;

    if (tokensReset) account.quota.resetsAt = tokensReset;
    else if (requestsReset) account.quota.resetsAt = requestsReset;

    account.usage.totalRequests++;
    account.usage.lastUsed = new Date().toISOString();

    // Log when approaching quota
    if (this._isNearQuota(account)) {
      const tokenPct = account.quota.tokensLimit
        ? ((1 - account.quota.tokensRemaining / account.quota.tokensLimit) * 100).toFixed(1)
        : '?';
      console.log(`[TeamClaude] Account "${account.name}" at ${tokenPct}% token usage — will switch on next request`);
    }
  }

  /**
   * Update cumulative token usage from response body data.
   */
  updateUsage(accountIndex, inputTokens, outputTokens) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    if (inputTokens) account.usage.totalInputTokens += inputTokens;
    if (outputTokens) account.usage.totalOutputTokens += outputTokens;
  }

  /**
   * Mark an account as rate-limited for a given duration.
   */
  markRateLimited(accountIndex, retryAfterSeconds) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    account.status = 'throttled';
    account.rateLimitedUntil = Date.now() + (retryAfterSeconds * 1000);
    console.log(`[TeamClaude] Account "${account.name}" rate limited for ${retryAfterSeconds}s`);
  }

  /**
   * Ensure an OAuth account's token is fresh, refreshing if needed.
   */
  async ensureTokenFresh(accountIndex) {
    const account = this.accounts[accountIndex];
    if (!account || account.type !== 'oauth') return;

    if (isTokenExpiringSoon(account.expiresAt)) {
      console.log(`[TeamClaude] Refreshing token for account "${account.name}"...`);
      try {
        const newTokens = await refreshAccessToken(account.refreshToken);
        account.credential = newTokens.accessToken;
        account.refreshToken = newTokens.refreshToken;
        account.expiresAt = newTokens.expiresAt;
        console.log(`[TeamClaude] Token refreshed for account "${account.name}"`);
      } catch (err) {
        console.error(`[TeamClaude] Token refresh failed for "${account.name}": ${err.message}`);
        account.status = 'error';
      }
    }
  }

  /**
   * Return a status summary of all accounts (safe to expose, no credentials).
   */
  getStatus() {
    return {
      currentAccount: this.accounts[this.currentIndex]?.name,
      switchThreshold: this.switchThreshold,
      accounts: this.accounts.map(a => ({
        name: a.name,
        type: a.type,
        status: a.status,
        quota: { ...a.quota },
        usage: { ...a.usage },
        rateLimitedUntil: a.rateLimitedUntil
          ? new Date(a.rateLimitedUntil).toISOString()
          : null,
      })),
    };
  }
}
