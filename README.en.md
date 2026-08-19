# pi-deepseek-balance

[中文](README.md) | English

A Pi extension that queries your **DeepSeek account balance** and **API usage cost**, and shows them live in the session footer.

## Features

- `/deepseek` command: balance + current session cost + cumulative cost across all sessions (per-model breakdown table)
- Live footer display: `DS Balance ¥102.70 · This session ¥0.0989`
  - Balance refreshes every 60 seconds (auto-retries after 15s on failure, showing a "balance fetch failed" hint)
  - Session cost updates automatically after every turn
  - **Only shown when a DeepSeek key is configured**
- LLM-callable tool `deepseek_balance`: just ask "How much DeepSeek credit do I have left?"

## Installation

### Option 1: Pi package manager (recommended, updatable)

Add to your global Pi config `~/.pi/agent/settings.json` (Windows: `C:\Users\<username>\.pi\agent\settings.json`):

```json
{
  "packages": ["npm:pi-deepseek-balance"]
}
```

Restart pi (or run `/reload`) to install automatically.

Or install directly from GitHub:

```json
{
  "packages": ["git:github.com/oscar-wang-xin/pi-deepseek-balance"]
}
```

### Option 2: Manual copy

Copy `deepseek-balance.ts` into the global extensions directory (or any project's `.pi/extensions/`):

- Global: `~/.pi/agent/extensions/`
- Project: `<project>/.pi/extensions/`

Restart pi (or run `/reload`) to activate.

## Configuring the DeepSeek key

No separate configuration needed — the extension reuses pi's model config automatically:

- Log in with `/login deepseek` (recommended)
- Or set the environment variable `DEEPSEEK_API_KEY`

The extension shows nothing when no key is configured.

## Usage

```
/deepseek
```

Or just ask: "How much DeepSeek credit do I have left?"

## Uninstall

- Installed via Option 1: remove the entry from `packages` in `settings.json`
- Installed via Option 2: delete the copied `deepseek-balance.ts`

## How it works

| Data | Source |
|---|---|
| Account balance | DeepSeek official API `GET https://api.deepseek.com/user/balance` |
| API cost | Pi's local session token usage × model pricing (matches official pricing) |

> Note: DeepSeek has no official usage-detail API, so "cost" is computed from pi's local session records.

## FAQ

**Footer shows "balance fetch failed"?**
The API/network is temporarily unavailable; it retries automatically after 15 seconds, nothing to do.

**Footer shows no DS info at all?**
No DeepSeek key is configured (see config section above).

**What currency is the cost in?**
Chinese Yuan (¥). DeepSeek bills in CNY and pi's built-in model pricing matches.

## License

MIT
