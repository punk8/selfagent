# Telegram-First SelfAgent Spec

## Summary

This spec defines the first implementation target for `selfagent`.

The system will be based on `pi-mono`, but extended so that Telegram becomes the first supported channel. The first milestone focuses on practical usability rather than a complete multi-channel framework.

## Goals

- support Telegram chat conversations
- support outbound Telegram text messages
- support outbound Telegram image sending
- support outbound Telegram file sending
- preserve and expose skill execution
- support computer-use capabilities behind explicit user authorization
- keep the initial memory system close to `pi-mono`
- support model access for OpenAI/Claude-style providers via:
  - API mode
  - auth/provider-managed mode

## Non-Goals

- no requirement to support Discord/Slack in the first delivery
- no requirement to replace the existing memory model yet
- no requirement to implement advanced memory recall, reranking, or memory agents
- no requirement to build a full OpenClaw-style plugin system in phase 1
- no requirement to support Telegram voice send in phase 1
- no requirement to support all provider families beyond the initial OpenAI/Claude-oriented target

## Product Requirements

### 1. Telegram Conversation Support

The system must support:

- receiving user messages from Telegram
- normalizing inbound events into a runtime-friendly conversation model
- replying in the correct Telegram conversation
- preserving reply context where practical

The runtime should not require Telegram-specific logic inside the main agent reasoning loop.

### 2. Telegram Outbound Media Support

The agent must be able to send:

- text
- image
- file

Expected adapter responsibilities:

- map runtime output types to Telegram send methods
- handle local file paths and generated artifacts
- apply Telegram-specific formatting and size/caption constraints
- preserve file/image naming where possible
- support fallback behavior when Telegram media constraints are hit

Out of scope for phase 1:

- voice message generation
- audio/video note UX
- rich Telegram button workflows beyond what is required for approval UX

### 3. Skill Support

The Telegram-backed runtime must preserve skill support from the `pi-mono` model.

Requirements:

- skills remain discoverable from workspace/channel-level locations
- Telegram sessions can use the same skill execution path as existing sessions
- skill usage should not depend on Slack-specific prompt or context assumptions

### 4. Computer Use With User Authorization

The agent must be able to use computer control capabilities, but only after user approval.

Minimum required behavior:

- computer-use actions are denied by default
- the agent can request approval
- the user can grant approval explicitly
- approval state is checked before computer-use actions execute

Initial approval model can be simple, but it must support:

- explicit deny
- explicit allow
- clear auditability in logs/session state

Stretch direction for later phases:

- one-time approval
- per-session approval
- expiration and revocation

### 5. Memory

The initial memory system should stay close to `pi-mono`.

Phase-1 memory behavior:

- workspace `MEMORY.md`
- conversation/channel `MEMORY.md`
- transcript/log files for older history lookup

Design constraint:

- memory access should be isolated behind a small surface so later retrieval upgrades are feasible

### 6. Model Provider Support

The system must support model access through two modes.

#### API Mode

Configuration examples:

- API key
- base URL
- model id
- provider kind

Supported target families:

- OpenAI-compatible
- Claude/Anthropic-compatible

#### Auth Mode

Inspired by `openclaw`, the runtime should also support authenticated/provider-managed access patterns where the system does not rely only on a raw API key sitting in one flat config field.

Expected design traits:

- auth resolution separate from request execution
- provider definitions separate from credentials
- room for future provider-specific auth adapters

The first implementation does not need to replicate all of `openclaw`'s provider system, but it must avoid locking the code into API-key-only assumptions.

## Architecture Proposal

### A. Core Runtime

Reuse `pi-mono` agent/runtime foundations where possible:

- workspace-centric runtime
- session/context persistence
- skill handling
- simple memory

Required change:

- remove direct Slack assumptions from the runtime-facing interface

### B. Channel Adapter Layer

Introduce a channel adapter boundary.

Recommended minimal surfaces:

- normalize inbound message/event to a common conversation envelope
- send text
- send image
- send file
- request approval / receive approval result
- expose platform metadata needed by the runtime

Initial adapter set:

- `TelegramAdapter`

Future-ready direction:

- additional adapters can be introduced later without rewriting the core runtime

### C. Conversation Model

Define a platform-neutral conversation/session key.

Properties should include:

- platform
- chat id
- optional thread/topic/reply target
- user identity
- message identity

The purpose is to prevent platform IDs from leaking deeply into runtime internals.

### D. Tool Authorization Layer

Introduce a lightweight capability gate between the agent and powerful tools.

At minimum:

- tool request enters authorization gate
- gate checks approval state
- if approved, tool executes
- if not approved, request is blocked and surfaced to the user

This should be generic enough to later cover:

- computer use
- shell/exec approvals
- filesystem write approvals

### E. Memory Layer

Do not redesign memory yet.

Instead:

- wrap existing `pi-mono`-style memory reads/writes in explicit helpers
- keep transcript/log access explicit
- ensure adapter-specific code does not own memory logic

### F. Model/Provider Layer

Introduce a provider abstraction with these minimum concepts:

- provider definition
- auth mode
- resolved credentials/session
- model identifier
- request transport

This layer should support:

- OpenAI API-style requests
- Claude API-style requests
- authenticated/provider-managed mode inspired by OpenClaw

## Suggested Module Split

Recommended phase-1 module boundaries:

- `core/agent`
  - runtime loop
  - session orchestration
  - tool coordination
- `channels/telegram`
  - inbound webhook/polling logic
  - outbound send logic
  - Telegram-specific rendering and media mapping
- `channels/types`
  - shared conversation/message abstractions
- `memory`
  - memory file loading
  - transcript/history helpers
- `providers`
  - model provider definitions
  - auth resolution
  - request execution
- `approvals`
  - approval state and enforcement
- `skills`
  - skill discovery and loading integration

## User Flows

### Flow 1: Normal Telegram Chat

1. User sends message in Telegram.
2. Telegram adapter normalizes the event.
3. Runtime loads session context, skills, and memory.
4. Agent produces text response.
5. Telegram adapter sends text response.

### Flow 2: Agent Sends Image

1. Agent decides to return an image artifact.
2. Runtime exposes a local/generated file path.
3. Telegram adapter determines image send path.
4. Telegram adapter uploads/sends image.
5. If caption or media constraints fail, adapter applies fallback behavior.

### Flow 3: Agent Sends File

1. Agent generates or references a file.
2. Runtime hands file path to the adapter.
3. Telegram adapter sends the artifact as document/file.

### Flow 4: Computer Use Approval

1. Agent attempts a computer-use action.
2. Approval layer checks authorization state.
3. If not approved, approval request is surfaced to the user.
4. User explicitly approves or denies.
5. Runtime continues only if approval is valid.

## Acceptance Criteria

Phase 1 is successful when:

- a Telegram user can chat with the agent reliably
- the agent can send text replies
- the agent can send an image artifact
- the agent can send a file artifact
- skills are usable from Telegram conversations
- computer-use actions are blocked until explicit approval
- memory still behaves like the default local `pi-mono` model
- model configuration supports both API mode and a non-API-key-only auth path

## Risks

- `pi-mono` has Slack assumptions in prompting, context, and output handling
- Telegram media constraints can leak platform-specific behavior into the runtime
- approval UX can become tangled with channel logic if not isolated early
- provider/auth support can sprawl if OpenClaw-like ideas are copied wholesale
- keeping default memory while preparing for future upgrades can tempt premature abstraction

## Open Questions

- should Telegram transport use webhook mode, polling mode, or support both?
- what is the exact approval UX in Telegram:
  - command-based
  - reply-based
  - inline buttons
- what is the first supported computer-use backend?
- how much of the existing `pi-mono` Slack prompt/output contract should be preserved versus replaced?
- what is the minimal auth-mode shape for OpenAI/Claude providers in phase 1?

## Recommended Implementation Order

1. Extract runtime-facing channel interfaces from `pi-mono`
2. Introduce a Telegram adapter with text-only flow
3. Add outbound image/file support
4. Reconnect skills through the Telegram path
5. Add approval-gated computer use
6. Introduce provider/auth abstraction
7. Refine memory seams for later iteration

## Reference Basis

This spec is based on:

- `pi-mono` as the implementation baseline
- `openclaw` as the reference for Telegram channel behavior and provider/auth direction
- `hermes-agent` as a secondary reference for session and memory extensibility tradeoffs
