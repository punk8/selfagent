# SelfAgent

Telegram-first agent runtime built on top of `pi-coding-agent`.

## Current Scope

- Telegram chat handling
- agent text replies
- agent image/file sending through `attach`
- workspace and conversation skills
- default disk-backed memory model
- limited `computer_use` tool with explicit Telegram approval
- interactive channel/model onboarding via CLI subcommands

## Install

```bash
npx selfagent@latest --version
```

or install globally:

```bash
npm install -g selfagent
```

## CLI Commands

### Start the runtime

```bash
selfagent start
```

or simply:

```bash
selfagent
```

If a default model or channel profile is missing and you are in an interactive terminal, `start` will guide you through configuring it inline.

Run in the background:

```bash
selfagent start --daemon
```

This prints:

- the daemon PID
- the active log file path

It also writes a pid record to:

- `~/.selfagent/run/selfagent.pid`

Check daemon status:

```bash
selfagent status
```

Stop the daemon:

```bash
selfagent stop
```

`status` also shows whether the Telegram whitelist is enabled and how many users are currently allowed.

Restart the daemon:

```bash
selfagent restart
```

Show the installed version:

```bash
selfagent --version
```

Upgrade the CLI:

```bash
selfagent --upgrade
```

### Add a channel

```bash
selfagent channels add
```

Current supported channel:

- Telegram

This command will prompt for:

- channel provider
- profile name
- Telegram bot token
- whether the profile should become the default channel

Authorize a Telegram user without manually finding their `user_id`:

```bash
selfagent channels authorize-user
```

This command enables the whitelist for the default Telegram profile, generates a short-lived code, and prints the exact message the user should send to the bot.

Example:

```text
/authorize ABCD1234
```

When that Telegram user sends the code to the bot, their `user_id` is added to the allowlist automatically.

### Add a model

```bash
selfagent models add
```

This command supports two onboarding modes.

API key mode:

- OpenAI
- Anthropic / Claude
- MiniMax (China)

Auth login mode:

- OpenAI (ChatGPT auth / `openai-codex`)

For API-key mode, the command prompts for:

- provider
- profile name
- model id
- API key
- whether the profile should become the default model

For OpenAI auth mode, the command prompts for:

- profile name
- interactive ChatGPT/Codex OAuth login
- default model id
- whether the profile should become the default model

## Configuration Files

SelfAgent now keeps user-maintained settings in a single TOML file, while still projecting runtime compatibility files for `pi`.

Primary user config:

- `~/.selfagent/config.toml`

This file contains:

- default channel/model profile selection
- channel profiles
- model profiles
- Telegram authorization state

Legacy `.json` config files are read as fallback and are folded into `config.toml` on the next save.

Projected runtime compatibility files:

- `~/.selfagent/agent/auth.json`
- `~/.selfagent/agent/models.json`

Conversation state:

- `~/.selfagent/conversations/telegram/<conversation>/`

Each Telegram conversation keeps:

- `session.jsonl`
- `MEMORY.md`
- `skills/`
- `attachments/`
- `scratch/`
- `approvals.json`

## Runtime Environment

Optional environment:

```bash
export SELFAGENT_WORKSPACE_ROOT=/absolute/path/to/workspace
export SELFAGENT_STATE_DIR=$HOME/.selfagent
export SELFAGENT_CONFIG_FILE=$HOME/.selfagent/config.toml
export SELFAGENT_AGENT_DIR=$HOME/.selfagent/agent
export SELFAGENT_MODEL_PROVIDER=openai
export SELFAGENT_MODEL_ID=gpt-5.4
export SELFAGENT_THINKING_LEVEL=medium
export SELFAGENT_LOG_LEVEL=debug
export SELFAGENT_LOG_FILE=/absolute/path/to/selfagent.log
export SELFAGENT_LOG_MAX_BYTES=10485760
export SELFAGENT_LOG_MAX_FILES=5
```

Runtime API-key overrides are still supported and take precedence over stored profile credentials:

```bash
export SELFAGENT_OPENAI_API_KEY=...
export SELFAGENT_ANTHROPIC_API_KEY=...
```

## Provider Notes

- `openai-codex` is the internal provider id for OpenAI ChatGPT/Codex auth
- `openai` is the API-key provider id for OpenAI
- `anthropic` is the API-key provider id for Claude/Anthropic
- `minimax-cn` is the internal provider id used for MiniMax China profiles
- MiniMax is currently projected to a custom `pi` provider using the official Anthropic-compatible endpoint `https://api.minimax.io/anthropic`

## Logging

Default logs go to stdout/stderr.

You can increase verbosity with:

```bash
SELFAGENT_LOG_LEVEL=debug selfagent start
```

You can also persist logs to a file with `SELFAGENT_LOG_FILE`.

If you use `start --daemon` and do not set `SELFAGENT_LOG_FILE`, SelfAgent defaults to:

```text
~/.selfagent/logs/runtime.log
```

### Built-in Log Rotation

When file logging is enabled, SelfAgent now rotates logs automatically to avoid unbounded growth.

Default policy:

- `10 MB` max size per file
- `5` total files retained

You can tune the policy with:

```bash
export SELFAGENT_LOG_MAX_BYTES=10485760
export SELFAGENT_LOG_MAX_FILES=5
```

Rotated files look like:

```text
runtime.log
runtime.log.1
runtime.log.2
```

## Notes

- `computer_use` is intentionally minimal in this phase and currently targets macOS only.
- Telegram transport currently runs in polling mode.
- Telegram access can now be restricted with a whitelist-driven `/authorize <code>` flow.
- Memory is still the simple `pi-mono`-style file model and is intended to evolve later.
- Provider failures are now surfaced to the user instead of collapsing into `"Done"`.
