# SelfAgent

## Purpose

This repository is for building a self-hosted, multi-channel agent runtime with a pragmatic first milestone:

- start from the `pi-mono` architecture and code style
- add Telegram as the first non-Slack channel
- support chat, file/image sending, skills, and computer-use workflows
- keep the first memory system simple and local
- leave clear seams for iterative expansion in memory, channels, auth, and tool/runtime orchestration

The project should optimize for:

- simple end-to-end operability before framework purity
- explicit module boundaries where channel-specific behavior can be isolated
- local-first development and inspectable runtime behavior
- incremental evolution instead of big-bang redesign

## Current Product Goal

Build an agent system based on `pi-mono` that can:

- receive and reply to Telegram messages
- send plain text, images, and files back to Telegram
- use workspace skills
- invoke computer-use tools behind explicit user authorization
- keep the default memory model initially, but preserve upgrade paths for stronger recall later
- support model access through both API-key mode and authenticated/provider-managed mode for OpenAI and Claude-compatible usage

## Reference Projects

Reference repos are cloned under `.tmp/` and should be treated as design references, not copy-paste dependencies.

- [`pi-mono`](./.tmp/pi-mono)
  - primary baseline for agent runtime, local workspace model, skills, and simple memory behavior
  - especially relevant:
    - `packages/mom`
    - `packages/agent`
    - `packages/ai`
- [`openclaw`](./.tmp/openclaw)
  - primary reference for multi-channel abstraction, channel plugins, Telegram channel behavior, auth/provider patterns, and memory extensibility
  - especially relevant:
    - `src/channels/plugins`
    - `extensions/telegram`
    - memory docs and provider/auth docs
- [`hermes-agent`](./.tmp/hermes-agent)
  - reference for gateway organization, session handling, memory-provider extensibility, and multi-platform runtime tradeoffs

When making design decisions:

- prefer `pi-mono` for the first runnable implementation shape
- borrow from `openclaw` when `pi-mono` is too Slack-specific
- use `hermes-agent` mainly as a comparison point, not as the primary architecture template

## Architectural Direction

The intended direction is:

1. Preserve the useful `pi-mono` core:
   - local workspace-centric runtime
   - skill loading and execution
   - simple memory files
   - agent loop and tool orchestration
2. Remove or isolate Slack assumptions:
   - no platform-specific branching inside core agent logic
   - channel integration should be moved behind adapters
3. Introduce a first-class Telegram adapter:
   - inbound message normalization
   - outbound text/image/file delivery
   - reply/thread/topic semantics where applicable
4. Keep tool and memory boundaries stable:
   - skills continue to behave as workspace/channel assets
   - memory starts simple, but interfaces should not block future retrieval upgrades
5. Introduce model/provider abstraction that supports:
   - direct API credentials
   - authenticated/provider-managed access patterns

## Non-Goals For The First Phase

Do not overbuild the first phase.

Not required in the first milestone:

- multi-channel support beyond Telegram
- advanced memory retrieval engines
- autonomous background memory consolidation
- broad plugin marketplace architecture
- full enterprise auth / RBAC model
- voice generation or Telegram voice-note sending

These can be added later if the seams are kept clean.

## Development Principles

- Favor working boundaries over ideal abstractions.
- Keep channel adapters thin and runtime-agnostic.
- Do not let Telegram-specific formatting rules leak into the core agent loop.
- Keep memory behavior inspectable on disk.
- Default to local, explicit configuration over hidden magic.
- Preserve user control around any powerful capability, especially computer use.
- Prefer additive changes over rewrites unless the current structure blocks the requirement directly.

## Skills

Skills are a core capability and must remain first-class.

Implementation direction:

- preserve `pi-mono`'s workspace/channel skill loading model
- ensure Telegram sessions can access the same skill resolution flow as Slack-style sessions
- do not make skills channel-specific unless the skill itself depends on channel behavior

## Computer Use And User Authorization

Computer-use capabilities are high-risk and must be gated.

Requirements:

- no automatic computer control without explicit user authorization
- authorization should be associated with a user/session/conversation scope
- approval UX should be auditable and revocable
- the runtime should be able to distinguish:
  - no approval yet
  - one-time approval
  - session-scoped approval
  - denied

The initial design can be simple, but the enforcement path must be explicit.

## Memory Direction

The initial memory system should stay close to `pi-mono`:

- workspace-level `MEMORY.md`
- channel/conversation-level `MEMORY.md`
- transcript/log based recall when needed

But the code structure should leave room for later upgrades:

- explicit memory read/write surface
- optional future retrieval layer
- optional future provider-backed memory

Do not hardcode assumptions that prevent later migration toward an `openclaw`-style recall layer.

## Model And Auth Direction

The runtime must support OpenAI- and Claude-family access through two broad modes:

- API mode
  - explicit API key / base URL / model id configuration
- Auth mode
  - authenticated/provider-managed access patterns inspired by `openclaw`
  - the auth representation should not be coupled to a single provider

The implementation should separate:

- provider resolution
- auth material resolution
- model capability selection
- runtime request execution

## Parallel Work And Subagents

If future implementation work splits into clearly independent tasks, parallel work is encouraged.

Examples:

- Telegram adapter development
- model/provider auth layer
- computer-use approval path
- memory interface cleanup
- skill/runtime integration tests

If the task boundaries are genuinely independent, it is acceptable to use spawned subagents for parallel development. Avoid parallelization when tasks share the same files or the same unstable design surface.

## Expected Deliverables

For major feature work, prefer producing:

- a short architecture note or spec before implementation
- incremental changes that keep the system runnable
- explicit verification notes
- documented assumptions and known limitations

## Working Rule

When the design is unclear:

- first inspect `pi-mono`
- then compare with `openclaw`
- only then introduce new abstractions

Do not introduce framework-level complexity unless a concrete requirement forces it.
