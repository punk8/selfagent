# SelfAgent CLI Setup And Model Onboarding Spec

## Summary

This spec defines the next-step setup experience for `selfagent`.

The current startup flow mixes three concerns into one path:

- starting the runtime
- selecting/configuring a channel
- selecting/configuring a model provider

That is acceptable for the first bootstrap, but it scales poorly once the project needs:

- multiple channels
- multiple model providers
- both API-key mode and auth-managed mode
- profile switching without re-running the whole startup wizard

The target design is to split setup into explicit CLI commands while keeping a guided interactive mode.

## Goals

- separate runtime start from configuration management
- support interactive addition of channels and models
- support model onboarding through:
  - API key mode
  - auth mode
- support these API-key providers in the first version:
  - OpenAI
  - Claude/Anthropic
  - MiniMax (China)
- support this auth-managed provider in the first version:
  - OpenAI via ChatGPT/Codex OAuth
- preserve compatibility with `pi-coding-agent` auth/model infrastructure
- make model failures visible to users instead of collapsing to `Done`

## Non-Goals

- no full OpenClaw-style provider plugin system yet
- no full profile marketplace or remote secret manager yet
- no Anthropic OAuth in this phase
- no channel-specific config UI beyond the required prompts
- no automated provider probing during the first write path beyond lightweight validation

## Problem Statement

Two issues are visible in the current implementation:

1. Startup and setup are tightly coupled.
   The runtime asks for Telegram and model credentials during `start`, which makes later management awkward.

2. Model onboarding is too shallow.
   The system can detect existing `pi` credentials, but there is no clean command-oriented workflow for:
   - adding a new provider
   - switching defaults
   - storing multiple model profiles
   - distinguishing API-key and OAuth-backed providers

There is also a related runtime bug that was just confirmed:

- the model path is wired in, but provider failures can produce an empty assistant message with `stopReason: "error"` and `errorMessage`, which was previously being swallowed by the `"Done."` fallback

## Research Notes

### 1. OpenClaw command design

`openclaw` separates onboarding concerns instead of hiding them in one start path.

Relevant references:

- grouped auth choice prompts: [.tmp/openclaw/src/commands/auth-choice-prompt.ts](/Users/shipeng.chen/Documents/project/selfagent/.tmp/openclaw/src/commands/auth-choice-prompt.ts)
- auth choice option construction: [.tmp/openclaw/src/commands/auth-choice-options.ts](/Users/shipeng.chen/Documents/project/selfagent/.tmp/openclaw/src/commands/auth-choice-options.ts)
- provider-specific model auth command: [.tmp/openclaw/src/commands/models/auth.ts](/Users/shipeng.chen/Documents/project/selfagent/.tmp/openclaw/src/commands/models/auth.ts)
- non-interactive auth application: [.tmp/openclaw/src/commands/onboard-non-interactive/local/auth-choice.ts](/Users/shipeng.chen/Documents/project/selfagent/.tmp/openclaw/src/commands/onboard-non-interactive/local/auth-choice.ts)

The main takeaways:

- auth selection should be provider-aware, not a flat list of random choices
- interactive prompts should first choose provider, then choose auth method
- model auth should be a dedicated command surface, not a side effect of startup

### 2. Bridging custom auth state into pi

OpenClaw keeps its own auth-profile store but explicitly bridges credentials into `pi`-compatible `auth.json` so `pi-coding-agent` can still use `ModelRegistry/AuthStorage`.

Reference:

- [.tmp/openclaw/src/agents/pi-auth-json.ts](/Users/shipeng.chen/Documents/project/selfagent/.tmp/openclaw/src/agents/pi-auth-json.ts)

Takeaway:

- `selfagent` should keep its own higher-level model profile metadata, but still project resolved credentials into `pi` files for runtime compatibility

### 3. MiniMax China API compatibility

MiniMax official docs currently expose both Anthropic-compatible and OpenAI-compatible APIs.

Official references:

- Anthropic-compatible API: [MiniMax Compatible Anthropic API](https://platform.minimax.io/docs/api-reference/text-anthropic-api)
- API overview: [MiniMax API Overview](https://platform.minimax.io/docs/api-reference/api-overview)
- OpenAI-compatible API: [MiniMax Compatible OpenAI API](https://platform.minimax.io/docs/api-reference/text-openai-api)

Key facts from the docs:

- MiniMax recommends the Anthropic-compatible path for text generation
- Anthropic-compatible base URL is `https://api.minimax.io/anthropic`
- OpenAI-compatible base URL is `https://api.minimax.io/v1`
- current supported text models include `MiniMax-M2.7`, `MiniMax-M2.5`, `MiniMax-M2.1`, and related highspeed variants

For `selfagent`, the first implementation should prefer the Anthropic-compatible path because it aligns better with the existing `pi` Anthropic-style tool flow.

## User Experience Targets

### 1. Runtime start

Command:

```bash
selfagent start
```

Responsibilities:

- load existing config
- resolve default channel profile
- resolve default model profile
- start the runtime

If required configuration is missing:

- do not silently start a half-configured runtime
- present a concise guided message:
  - no channel configured -> suggest `selfagent channels add`
  - no model configured -> suggest `selfagent models add`
- optionally offer an inline prompt to run the missing setup immediately in interactive terminals

### 2. Add channel

Command:

```bash
selfagent channels add
```

Phase-1 supported channel:

- Telegram

Interactive flow:

1. choose channel type
2. choose a profile name, defaulting to `telegram-default`
3. prompt for Telegram bot token
4. optionally mark as default channel profile
5. persist channel profile metadata

### 3. Add model

Command:

```bash
selfagent models add
```

Interactive flow:

1. choose auth mode
   - API key
   - Auth login
2. if API key:
   - choose provider:
     - OpenAI
     - Claude/Anthropic
     - MiniMax China
   - enter model id
   - enter API key
   - apply provider-specific defaults
3. if Auth login:
   - choose provider:
     - OpenAI ChatGPT/Codex
   - run interactive OAuth
   - optionally choose a default OAuth model
4. choose profile name or accept suggested default
5. optionally mark as default model profile
6. persist profile metadata and project credentials into `pi` auth storage

### 4. List configured resources

Not required for the first implementation, but this spec reserves these commands:

```bash
selfagent channels list
selfagent models list
selfagent models use
```

The first implementation may postpone them, but the storage model should assume they will exist.

## Command Surface Proposal

Recommended first CLI surface:

```bash
selfagent start
selfagent channels add
selfagent models add
```

Future-safe expansion:

```bash
selfagent channels list
selfagent channels use <profile>
selfagent models list
selfagent models use <profile>
selfagent doctor
```

## Configuration Model

The current `config.json` is too flat for multiple channels and models. It should evolve into:

### 1. Root config

Path:

- `.selfagent/config.json`

Suggested responsibility:

- selected default channel profile id
- selected default model profile id
- workspace-level runtime defaults
- log configuration

Suggested shape:

```json
{
  "defaultChannelProfileId": "telegram-default",
  "defaultModelProfileId": "openai-codex-default",
  "thinkingLevel": "medium",
  "logLevel": "info",
  "logFile": ".selfagent/logs/selfagent.log"
}
```

### 2. Channel profiles

Path:

- `.selfagent/channels.json`

Suggested shape:

```json
{
  "profiles": {
    "telegram-default": {
      "kind": "telegram",
      "telegramBotTokenRef": "inline"
    }
  }
}
```

For phase 1, the token may still be stored inline or in a provider-specific secure store. The key point is that channel config must be profile-based.

### 3. Model profiles

Path:

- `.selfagent/models.json`

Suggested shape:

```json
{
  "profiles": {
    "openai-codex-default": {
      "provider": "openai-codex",
      "authMode": "oauth",
      "modelId": "gpt-5.4"
    },
    "anthropic-api-default": {
      "provider": "anthropic",
      "authMode": "apiKey",
      "modelId": "claude-sonnet-4-5"
    },
    "minimax-cn-default": {
      "provider": "minimax-cn",
      "authMode": "apiKey",
      "modelId": "MiniMax-M2.5",
      "compatibility": "anthropic",
      "baseUrl": "https://api.minimax.io/anthropic"
    }
  }
}
```

### 4. Projected pi credentials

Paths:

- `.selfagent/agent/auth.json`
- `.selfagent/agent/models.json`

These remain the runtime-facing compatibility layer for `pi-coding-agent`.

Design rule:

- `selfagent` owns the user-facing profile metadata
- `pi` owns runtime credential/model resolution
- `selfagent` projects profile choices into `pi` storage before runtime start

## Provider Support Spec

### API-key mode

#### OpenAI

- provider id: `openai`
- prompt fields:
  - profile name
  - model id
  - API key
- optional future field:
  - custom base URL

#### Claude/Anthropic

- provider id: `anthropic`
- prompt fields:
  - profile name
  - model id
  - API key

#### MiniMax China

Recommended first implementation:

- internal provider id: `minimax-cn`
- runtime compatibility mode: `anthropic`
- projected transport:
  - base URL `https://api.minimax.io/anthropic`
  - auth header via API key

Prompt fields:

- profile name
- model id
- API key

Default model suggestion:

- `MiniMax-M2.5`

Rationale:

- MiniMax’s official docs recommend the Anthropic-compatible text path
- this is a cleaner fit with the current `pi` Anthropic-style runtime assumptions than pretending MiniMax is plain OpenAI

### Auth mode

#### OpenAI via ChatGPT/Codex auth

Recommended first implementation:

- provider id: `openai-codex`
- login path uses `AuthStorage.login("openai-codex", ...)`
- default model suggestion:
  - `gpt-5.4`

Important product rule:

- this auth path should be presented to the user as `OpenAI (ChatGPT auth)`
- but internally it maps to `openai-codex`

This matters because:

- OAuth-backed ChatGPT auth does not make generic `openai/*` API-key models available
- it should be treated as a separate provider family during selection and runtime resolution

## Interactive Prompt Design

### `selfagent start`

If no config is present:

1. explain that runtime setup is incomplete
2. offer to launch missing setup inline
3. otherwise instruct the user to run:
   - `selfagent channels add`
   - `selfagent models add`

`start` should not be the only place where setup can happen.

### `selfagent channels add`

Prompt outline:

1. `Channel provider`
2. `Profile name`
3. `Telegram bot token`
4. `Set as default channel?`

### `selfagent models add`

Prompt outline:

1. `Model auth mode`
2. if API key:
   - `Provider`
   - `Profile name`
   - `Model ID`
   - `API key`
   - `Set as default model?`
3. if Auth login:
   - `Provider`
   - run OAuth
   - `Default model ID`
   - `Set as default model?`

The UX should follow the same principle visible in OpenClaw:

- first choose provider group
- then choose method
- then gather provider-specific fields

## Runtime Resolution Rules

When `selfagent start` runs:

1. load root config
2. resolve default channel profile
3. resolve default model profile
4. project model credentials/config into `pi` runtime files if needed
5. start runtime with explicit resolved model selection when possible

Important rule:

- if a default model profile exists, `start` should pass an explicit model selection instead of relying on implicit runtime defaults

This avoids the current confusion where logs said `openai/gpt-4 (default)` while the actual session used `gpt-5.4`.

## Error Handling Requirements

The runtime must surface model/provider failures clearly.

Minimum requirements:

- if the assistant message ends with `stopReason: "error"` and an `errorMessage`, show that message to the user
- do not fall back to `"Done"` when the provider actually failed
- include the actual provider/model in logs where available

Examples:

- quota exceeded
- invalid API key
- expired OAuth login
- unsupported model id

## Implementation Plan

### Phase A

- fix assistant-error handling in runtime reply extraction
- stop logging fake default model labels

### Phase B

- add CLI argument parsing
- implement `selfagent start`
- preserve current behavior as fallback if no subcommand is supplied

### Phase C

- implement `selfagent channels add`
- move Telegram token setup out of generic startup-only flow

### Phase D

- implement `selfagent models add`
- support:
  - OpenAI API key
  - Anthropic API key
  - MiniMax China API key
  - OpenAI ChatGPT/Codex OAuth

### Phase E

- project resolved profiles into `.selfagent/agent/auth.json` and `.selfagent/agent/models.json`
- start runtime using the selected model profile explicitly

## Risks

- if profile metadata and `pi` projection diverge, runtime behavior will become confusing
- MiniMax compatibility needs careful provider mapping; using the wrong transport will create tool-call incompatibilities
- ChatGPT OAuth and OpenAI API-key flows must remain clearly separated in UX
- mixing “setup during start” with dedicated setup commands can create duplicate code unless onboarding helpers are factored early

## Acceptance Criteria

This spec is satisfied when:

- `selfagent start` can launch without forcing the user through every setup step each time
- `selfagent channels add` can interactively add a Telegram channel profile
- `selfagent models add` can interactively add:
  - OpenAI API-key profile
  - Anthropic API-key profile
  - MiniMax China API-key profile
  - OpenAI ChatGPT-auth profile
- the runtime uses a selected model profile explicitly
- provider failures are surfaced as real errors rather than `"Done"`
