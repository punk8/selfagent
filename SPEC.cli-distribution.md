# SelfAgent CLI Distribution And Onboarding Spec

## Summary

This spec defines the next CLI packaging and onboarding upgrade for `selfagent`.

The goal is to turn the current repo-local developer CLI into a distributable end-user command that can be installed and run directly, while preserving the existing Telegram-first runtime and profile model.

Primary outcomes:

- publishable `selfagent` CLI with a proper `bin` entry
- default user state/config under `~/.selfagent`
- first-run guided setup from the CLI
- stable command surface for runtime, channel, and model management
- built-in `--version` and `--upgrade`

## Current Gaps

Current repository state:

- `package.json` is still `private` and has no `bin`
- local usage assumes `npm run dev -- ...`
- default state directory is `<cwd>/.selfagent`
- command surface supports `start`, `stop`, `status`, `channels add/list/authorize-user`, `models add/list/remove`
- there is no `restart`
- there is no `--version`
- there is no CLI-level upgrade command

This is fine for local development, but it is not yet shaped like an installable tool.

## Reference Findings

### pi-mono

Relevant patterns:

- package-level CLI distribution uses `bin -> dist/*.js`
- built artifacts are chmod'ed executable during build
- home-directory config is the default for user-facing CLI state

Reference files:

- `.tmp/pi-mono/packages/mom/package.json`
- `.tmp/pi-mono/packages/mom/src/main.ts`
- `.tmp/pi-mono/packages/pods/package.json`
- `.tmp/pi-mono/packages/pods/src/cli.ts`
- `.tmp/pi-mono/packages/pods/src/config.ts`

### hermes-agent

Relevant patterns:

- central user config lives under `~/.hermes`
- upgrade UX is exposed as a recommended command rather than magic in-place mutation
- managed-install environments can override the recommended update command

Reference files:

- `.tmp/hermes-agent/hermes_cli/config.py`

## Design Choice

For phase 1:

- package `selfagent` as a normal npm CLI
- keep the runtime implementation in TypeScript/Node
- install/run as `selfagent ...`
- support both:
  - global install style: `npm install -g selfagent`
  - ephemeral run style: `npx selfagent@latest ...`
- implement `selfagent --upgrade` as a user-facing wrapper that prints and, when feasible, executes the recommended npm upgrade command

This avoids building a custom installer first.

## Goals

1. Make `selfagent` publishable and runnable as a real CLI command.
2. Default all user state/config to `~/.selfagent`.
3. Keep startup guided for users who have not configured a model or channel yet.
4. Support the full runtime/admin command surface from the installed CLI.
5. Add `restart`, `--version`, and `--upgrade`.
6. Preserve the current profile model for channels and models.

## Non-Goals

Not required in this phase:

- a shell installer script
- platform-native package managers beyond npm
- Windows service management
- auto-updating the running daemon binary in place
- multiple simultaneous daemon profiles
- full config editing UX

## Distribution Model

### Package Shape

`package.json` should be changed to:

- remove `"private": true`
- add `"version"`
- add `"bin": { "selfagent": "dist/main.js" }`
- add a build script that emits executable JS with a shebang
- add a `files` allowlist for publishable artifacts

Expected publish flow:

- `npm publish`
- user runs `npx selfagent@latest ...` or installs globally

### Runtime Entry

`dist/main.js` should be directly executable with:

- `#!/usr/bin/env node`

The source entry should preserve the current command dispatch model.

## Default State Layout

### User State Root

Default state root becomes:

- `~/.selfagent`

This applies unless explicitly overridden by:

- `SELFAGENT_STATE_DIR`

Default config file becomes:

- `~/.selfagent/config.toml`

Projected runtime files remain:

- `~/.selfagent/agent/auth.json`
- `~/.selfagent/agent/models.json`

Daemon runtime files remain under:

- `~/.selfagent/run/`
- `~/.selfagent/logs/`

Conversation state remains under:

- `~/.selfagent/conversations/telegram/...`

### Workspace Root

Workspace root should remain:

- current working directory by default

unless overridden by:

- `SELFAGENT_WORKSPACE_ROOT`

Rationale:

- `selfagent` is still a workspace-centric agent runtime
- moving state to home dir should not force skills/memory/workspace behavior into home dir

## First-Run Onboarding

### Start Command Behavior

When a user runs:

- `selfagent`
- `selfagent start`

the CLI should validate, in order:

1. default model profile
2. default channel profile

If either is missing and the terminal is interactive, start should launch a guided setup flow.

### Guided Setup Behavior

The guide should:

- explain what is missing
- offer to configure it immediately
- reuse the existing `models add` / `channels add` prompts

If a default profile already exists, the guide should ask whether the user wants to replace or keep it.

For this phase:

- replacement can be implemented as “create or update and set default”
- model and channel guides do not need a separate wizard file

### Channel Guide

Current scope:

- only Telegram

So the guide should:

- state that Telegram is currently the only supported channel
- prompt for Telegram bot token
- create/update the default channel profile

### Model Guide

The guide should:

- prompt for auth mode
- support the current providers already supported by `models add`
- if a default model already exists, explicitly ask whether to overwrite it

## Command Surface

### Top-Level Runtime Commands

Required:

- `selfagent start`
- `selfagent start --daemon`
- `selfagent restart`
- `selfagent stop`
- `selfagent status`

Behavior:

- `restart` means stop existing daemon if present, then start again in daemon mode
- plain `start` runs in foreground unless `--daemon` is passed

### Channel Commands

Required:

- `selfagent channels add`
- `selfagent channels list`
- `selfagent channels authorize-user`

Current behavior should be preserved.

### Model Commands

Required:

- `selfagent models add`
- `selfagent models list`
- `selfagent models remove <profile-id>`

Current behavior should be preserved.

## Version And Upgrade

### Version

The CLI should support:

- `selfagent --version`
- `selfagent -v`

Output:

- package version only

Implementation:

- read from package metadata or inject at build time

### Upgrade

The CLI should support:

- `selfagent --upgrade`
- optionally `selfagent upgrade`

Phase-1 behavior:

- determine the recommended npm upgrade command
- default recommendation:
  - global install users: `npm install -g selfagent@latest`
  - npx users: `npx selfagent@latest`
- if the CLI can confidently detect a global npm install, it may execute the npm upgrade command after confirmation
- otherwise it should print the recommended command and explain that ephemeral `npx` runs do not need local upgrading

Important constraint:

- do not attempt risky in-place package mutation when execution context is ambiguous

## Backward Compatibility

### Existing Local Usage

These should continue to work in development:

- `npm run dev -- start`
- `npm run dev -- channels add`
- `npm run dev -- models add`

### Existing Config

The current TOML config format should remain valid.

Changing the default state root to `~/.selfagent` does not need to auto-migrate `<cwd>/.selfagent` in this phase, but the CLI should:

- honor `SELFAGENT_STATE_DIR`
- mention the state root in `status`

Optional small enhancement:

- if `<cwd>/.selfagent/config.toml` exists and `~/.selfagent/config.toml` does not, prefer the explicit env override path rather than guessing

## Implementation Plan

### A. Package For Distribution

Update:

- `package.json`
- build script
- published file list

Ensure:

- compiled entry is executable
- `selfagent` is the installed command name

### B. Home-Dir State Defaults

Update config loading so default state root uses `os.homedir()`:

- `~/.selfagent`

### C. CLI Command Expansion

Extend `src/main.ts` and `src/commands.ts` with:

- `restart`
- `--version`
- `--upgrade`

### D. Guided Start Flow

Refine start-time checks:

- if no default model, guide user through model setup
- if no default channel, guide user through channel setup
- if defaults already exist, offer replace/keep when guide is explicitly entered from startup

### E. Documentation

Update README for:

- install/run commands
- default home-dir state
- command surface
- version/upgrade usage

## Verification

Minimum verification for this phase:

1. `npm run build`
2. `node dist/main.js --version`
3. `node dist/main.js --upgrade`
4. `node dist/main.js status`
5. `node dist/main.js restart` with daemon lifecycle validation
6. interactive smoke:
   - missing model -> guided model setup
   - missing channel -> guided channel setup

## Risks

### Install Context Detection

Detecting whether the user installed globally or is running via `npx` is not always reliable.

So:

- recommendation messaging should be first-class
- automatic upgrade execution should be conservative

### Home-Dir State vs Workspace Root

Moving state to `~/.selfagent` while keeping workspace root at `cwd` is the right compromise for now, but it means:

- daemon state is global
- workspace behavior still depends on where `start` was launched

This is acceptable for phase 1 and should be documented.
