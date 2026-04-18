# TeamClaude

Multi-account Claude proxy with automatic quota-based rotation for [Claude Code](https://claude.ai/claude-code).

Sits transparently between Claude Code and the Anthropic API, managing multiple Claude Max (or API key) accounts and automatically switching when one approaches its session or weekly quota limit.

![TeamClaude TUI](screenshots/teamclaude.png)

## Features

- **Automatic account rotation** — switches accounts when session (5h) or weekly (7d) quota reaches the configured threshold, using configurable random, next, or from-first preference order
- **Auto-retry on 429** — waits the `retry-after` duration and retries the same account; switches to the next on persistent errors
- **Interactive TUI** — real-time dashboard with color-coded quota bars, reset countdowns, activity log, and keyboard controls, including Sonnet weekly usage when available
- **OAuth token management** — automatically refreshes tokens nearing expiry and persists them to config; client token refreshes pass through untouched
- **Optional Sonnet-to-Opus fallback** — when Sonnet weekly usage is high, can keep rotating accounts and finally rewrite Sonnet requests to Opus on a weekly-eligible account
- **Hot-reload accounts** — add accounts via `import` or `login` while the server is running, press **R** to pick them up
- **Account deduplication** — detects duplicate accounts by UUID and keeps the most recent
- **Request logging** — optional full request/response logging for debugging
- **Zero dependencies** — uses only Node.js built-in modules

## Quick Start

Requires Node.js 18+.

```bash
# Install
npm install -g @guilhermesilveira/teamclaude

# Add your first account (opens browser for OAuth)
teamclaude login

# Add a second account
teamclaude login

# Start the proxy
teamclaude server

# In another terminal, run Claude Code through the proxy
teamclaude run
```

You can also import existing Claude Code credentials instead of logging in:

```bash
claude /login           # Log into an account in Claude Code
teamclaude import       # Import its credentials
```

## Adding Accounts

### OAuth Login (recommended)

The easiest way to add accounts — opens your browser for authentication:

```bash
teamclaude login
```

Uses the same OAuth flow as Claude Code. Auto-detects the account email and subscription tier. Logging in with the same account again updates its credentials.

You can add accounts while the server is running — press **R** in the TUI to reload.

### Import from Claude Code

If you already have Claude Code set up, you can import its credentials directly:

```bash
claude /login           # Log into an account in Claude Code
teamclaude import       # Import its credentials
```

Re-importing the same account updates its credentials. You can also import from a custom path:

```bash
teamclaude import --from /path/to/credentials.json
```

### API Key

For Anthropic API key accounts (billed via Console):

```bash
teamclaude login --api
```

## Usage

### Start the proxy server

```bash
teamclaude server
```

When running from a TTY, shows an interactive TUI with:
- Account table with session/weekly quota progress bars and reset countdowns, plus a Sonnet weekly bar for OAuth accounts when available
- Real-time activity log with request tracking
- Keyboard shortcuts (see below)

Falls back to plain log output when not a TTY (e.g. running as a service).

#### TUI Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `s` | Switch active account |
| `a` | Add account (import or API key) |
| `x` | Remove an account |
| `r` | Reload accounts from config |
| `l` | Toggle request file logging |
| `q` | Quit |

In selection mode, use `j`/`k` or arrow keys to navigate, `Enter` to confirm, `Esc` to cancel.

### Run Claude Code through the proxy

```bash
teamclaude run
```

Or manually set the environment:

```bash
eval $(teamclaude env)
claude
```

### Other commands

```bash
teamclaude accounts          # List accounts with subscription tier and token status
teamclaude accounts -v       # Also show token expiry times
teamclaude config            # Interactively edit config values
teamclaude status            # Show live proxy status (requires running server)
teamclaude remove <name>     # Remove an account
teamclaude api <path>        # Call an API endpoint with account credentials
teamclaude help              # Show all commands
```

### Request logging

Log full request/response details to a directory (one file per request):

```bash
teamclaude server --log-to /tmp/requests
```

You can also toggle request file logging live in the TUI with `l`.

## npm Release

### Publish to npm

From the repo root on the branch/version you want to release:

```bash
npm publish --access public
```

If npm says that version already exists, bump the version in `package.json` first and publish again.

### Install globally

```bash
npm install -g @guilhermesilveira/teamclaude
```

### Update a global install

```bash
npm install -g @guilhermesilveira/teamclaude@latest
```

## Configuration

Config is stored at `~/.config/teamclaude.json` (or `$XDG_CONFIG_HOME/teamclaude.json`). A random proxy API key is generated on first use.

Override the config path with `TEAMCLAUDE_CONFIG`:

```bash
TEAMCLAUDE_CONFIG=./my-config.json teamclaude server
```

### Config format

```json
{
  "proxy": {
    "port": 3456,
    "apiKey": "tc-auto-generated-key"
  },
  "upstream": "https://api.anthropic.com",
  "switchThreshold": 0.98,
  "switchMode": "random",
  "usageRefreshIntervalSeconds": 600,
  "maxRetryWaitSeconds": 600,
  "modelFallback": {
    "sonnet7dThreshold": 0.98,
    "opusModel": "claude-opus-4-6"
  },
  "accounts": [
    {
      "name": "user@example.com",
      "type": "oauth",
      "accountUuid": "...",
      "accessToken": "sk-ant-oat01-...",
      "refreshToken": "sk-ant-ort01-...",
      "expiresAt": 1774384968427
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `proxy.port` | Local port the proxy listens on |
| `proxy.apiKey` | API key clients use to authenticate with the proxy |
| `upstream` | Upstream API base URL |
| `switchThreshold` | Quota utilization (0–1) at which to switch accounts |
| `switchMode` | How TeamClaude chooses the next eligible account: `random`, `next`, or `from-first` |
| `usageRefreshIntervalSeconds` | How often OAuth usage is refreshed from `/api/oauth/usage` |
| `maxRetryWaitSeconds` | Maximum `retry-after` TeamClaude will wait before returning the upstream 429 immediately |
| `modelFallback.sonnet7dThreshold` | Optional Sonnet 7-day utilization threshold (0–1) that triggers model-aware rotation |
| `modelFallback.opusModel` | Model name to use when falling back from Sonnet to Opus |

You can edit these values interactively with:

```bash
teamclaude config
```

### Sonnet-to-Opus fallback

If `modelFallback.sonnet7dThreshold` is set, TeamClaude applies a second-stage routing pass for Sonnet requests:

1. It first uses the normal account rotation logic based on session and weekly thresholds
2. If the selected account has `seven_day_sonnet >= sonnet7dThreshold`, it keeps rotating
3. While rotating, it skips accounts whose session or weekly usage is already above `switchThreshold`
4. If no Sonnet-safe account is found, it falls back to the first account whose general weekly usage is still below `switchThreshold`
5. That request is rewritten from Sonnet to the configured Opus model on that account

If an account does not expose `seven_day_sonnet`, TeamClaude allows Sonnet on that account instead of blocking it.

## How It Works

1. Claude Code connects to the local proxy instead of `api.anthropic.com`
2. The proxy selects the active account and forwards requests with that account's credentials
3. OAuth tokens expiring within 5 minutes are automatically refreshed and persisted to config
4. Rate limit headers from the API (`anthropic-ratelimit-unified-*`) track session (5h) and weekly (7d) quota utilization, and OAuth accounts can also refresh extra usage buckets from `/api/oauth/usage`
5. When usage reaches the threshold, the proxy switches to the next eligible account using the configured switch mode
6. On 429 responses, the proxy waits the `retry-after` duration and retries; on persistent errors, it switches accounts
7. Transient network errors (connection reset, timeout) drop the connection so the client can retry
8. If all accounts are exhausted, returns 429 with the soonest reset time
9. Client token refresh requests (`/v1/oauth/token`) are relayed to upstream untouched — the proxy and client manage their own token lifecycles independently

For OAuth accounts, TeamClaude may display multiple rolling subscription buckets:
- `Ses` — 5-hour session usage
- `Wk` — all-model 7-day usage
- `S7` — Sonnet-specific 7-day usage when exposed by the OAuth usage endpoint

## License

MIT
