# SelfAgent Timeout Governance Spec

## Goal

Prevent SelfAgent from hanging indefinitely when a model request or tool-driven run stops making progress.

This applies to:

- interactive Telegram conversation turns
- scheduled cron task runs

The system should:

- detect idle runs that stop producing meaningful activity
- abort stuck runs explicitly
- return a clear, user-facing error instead of silently hanging
- keep one stuck run from wedging an entire conversation queue forever

## Problem

Current behavior:

- interactive turns call `await session.prompt(...)` directly
- cron runs call `await session.prompt(...)` directly
- there is no SelfAgent-owned watchdog around these calls
- if the provider hangs without returning tokens or an error, the turn can remain stuck indefinitely

Consequences:

- one Telegram conversation queue can remain blocked forever
- cron jobs can hang for an arbitrary amount of time
- users see no result and little diagnostic feedback

## Reference direction

### Hermes

- uses activity-based timeout monitoring
- polls agent activity periodically
- interrupts agent when no tool/API/stream activity occurs for too long
- cron uses the same inactivity logic

### OpenClaw

- interactive runs use LLM idle timeout on the model stream
- cron runs add a separate job-level hard timeout using `AbortController`
- timeout surfaces as a clear user-visible error

## SelfAgent design

SelfAgent should combine both approaches:

1. **Interactive turns**
   - add inactivity timeout
   - no separate hard timeout in phase 1

2. **Cron runs**
   - add inactivity timeout
   - add separate hard wall-clock timeout

This keeps interactive UX simple while giving cron an extra safety ceiling.

## Definitions

### Activity

A run counts as active whenever SelfAgent observes any `AgentSessionEvent` after the prompt begins.

Examples:

- assistant text delta
- tool-related session events
- assistant message completion

If no session events arrive for too long, the run is considered idle.

### Inactivity timeout

The maximum allowed time since the last observed activity event.

When exceeded:

- call `session.abort()`
- fail the run with a timeout error

### Hard timeout

The maximum allowed wall-clock duration of the full run.

When exceeded:

- call `session.abort()`
- fail the run even if activity tracking is missing or unreliable

This is cron-only for phase 1.

## Configuration

Phase 1 uses environment variables plus defaults.

Interactive turns:

- `SELFAGENT_AGENT_INACTIVITY_TIMEOUT_SECONDS`
- default: `0` (disabled)
- `0` disables inactivity timeout

Cron runs:

- `SELFAGENT_CRON_INACTIVITY_TIMEOUT_SECONDS`
- default: `0` (disabled)
- `0` disables inactivity timeout

- `SELFAGENT_CRON_HARD_TIMEOUT_SECONDS`
- default: `0` (disabled)
- `0` disables hard timeout

Config-file support can be added later once these semantics settle.

## User-visible behavior

### Interactive Telegram turns

If an interactive turn times out:

- the turn aborts
- the Telegram user receives a clear failure message

Suggested wording:

- inactivity timeout:
  - `The model stopped responding before the request finished. Please try again.`
- hard timeout is not used for interactive turns in phase 1

The message should avoid implementation detail unless useful for debugging.

### Cron runs

If a cron run times out:

- the run record is written with error status
- the job state records the timeout error
- the origin Telegram conversation receives a short failure notification

Suggested wording:

- inactivity timeout:
  - `Scheduled task "<name>" timed out because the model stopped responding.`
- hard timeout:
  - `Scheduled task "<name>" exceeded the maximum execution time and was aborted.`

This avoids silent cron failures.

## Logging

On timeout, log:

- run type: `interactive` or `cron`
- conversation key or job id
- timeout type: `inactivity` or `hard`
- configured threshold
- elapsed duration
- last observed activity time

Also log periodic debug heartbeat messages while waiting:

- every 30 seconds for interactive turns
- every 30 seconds for cron runs

These logs should be `debug` or `warn`, not `info` spam.

## Implementation shape

Add a small timeout helper that wraps `session.prompt(...)`.

Inputs:

- session
- prompt text
- run label
- inactivity timeout seconds
- hard timeout seconds
- activity timestamp accessor

Behavior:

1. start prompt
2. poll every few seconds
3. compare now with last activity
4. compare now with startedAt
5. on timeout:
   - call `session.abort()`
   - reject with a structured timeout error
6. otherwise resolve with the normal prompt completion

## Error model

Introduce a structured error type:

- `SelfAgentTimeoutError`
  - `kind = "inactivity" | "hard"`
  - `scope = "interactive" | "cron"`
  - `timeoutSeconds`
  - `message`

This keeps downstream handling explicit.

## Downstream handling

### Interactive path

`runConversationTurn(...)` should:

- wrap `session.prompt(...)` in timeout monitoring
- on timeout, throw a user-facing timeout error string

`runtime.ts` already catches turn failures and sends an error message back to Telegram, so no new runtime path is required.

### Cron path

`runScheduledTask(...)` should:

- wrap `session.prompt(...)` in timeout monitoring
- surface a structured timeout error

`runtime.ts` cron scheduler should:

- record timeout in run log
- update job state
- send a failure notification to the origin Telegram conversation

## Non-goals

Not required in phase 1:

- per-provider timeout tuning
- retry/backoff after timeout
- OpenClaw-style stream wrapper integration inside `pi` internals
- Hermes-style staged warning messages to users before timeout fires

## Verification targets

Phase 1 is complete when:

1. an interactive Telegram turn that stops producing activity is aborted automatically
2. the Telegram user receives a timeout error instead of waiting forever
3. a stuck cron run is aborted automatically
4. the cron job records timeout failure state
5. the origin Telegram conversation receives a cron timeout notification
