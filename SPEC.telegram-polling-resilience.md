# Telegram Polling Resilience Spec

## Summary

SelfAgent currently relies on grammY's simple `bot.start()` long polling. This is adequate for a small first milestone, but it leaves important runtime behavior implicit:

- polling liveness is not visible in SelfAgent logs
- stalled `getUpdates` calls are only bounded by library/default request behavior
- update offset progress is not persisted across restarts
- `409 Conflict` and recoverable network errors rely on the process-level failure path instead of an explicit restart policy

This spec defines a focused Telegram polling supervisor inspired by `openclaw`, but intentionally smaller than OpenClaw's full `@grammyjs/runner` architecture.

## Goals

- keep Telegram polling alive during long-running daemon sessions
- detect and recover from `getUpdates` stalls
- persist safe update progress on disk
- avoid replaying already-handled updates after restart
- recover from transient Telegram network failures with bounded backoff
- handle `409 getUpdates` conflicts by restarting the polling cycle from a fresh bot/transport
- preserve existing Telegram handlers, conversation queues, approvals, cron delivery, skills, and formatting behavior

## Non-Goals

- do not introduce `@grammyjs/runner` in this phase
- do not implement horizontal scaling or multi-process polling
- do not parallelize Telegram update handling beyond the existing conversation queues
- do not add webhook mode in this change
- do not redesign channel abstractions

## OpenClaw Reference

Relevant OpenClaw behaviors:

- `TelegramPollingSession` wraps polling in an outer restart loop.
- `getUpdates` calls are observed for liveness and restarted when stalled.
- per-method Telegram request timeouts bound `getUpdates`, `deleteWebhook`, and startup calls.
- last handled update ID is persisted per account/bot.
- persisted offset is confirmed on startup with `getUpdates({ offset: last + 1, limit: 1, timeout: 0 })`.
- `409 getUpdates` conflicts mark transport dirty and restart after webhook cleanup.
- recoverable network errors restart polling with exponential backoff and jitter.

SelfAgent should borrow the resilience model, not the whole runner stack.

## Current SelfAgent Behavior

Current entry point:

- `startTelegramRuntime(...)` creates one `TelegramAdapter`
- handlers are registered on `adapter.bot`
- cron scheduler starts
- runtime awaits `adapter.bot.start()`

Limitations:

- offset lives only inside grammY memory
- a restart can replay Telegram updates that were already handled before process exit
- a wedged `getUpdates` path has no SelfAgent-owned watchdog
- middleware errors use grammY defaults unless explicitly caught
- restart policy is process-level, not polling-cycle-level

## Proposed Design

### A. Polling Supervisor

Add a SelfAgent-owned polling loop that:

1. creates a fresh `TelegramAdapter`
2. registers the existing handlers on that bot
3. deletes Telegram webhook before polling
4. confirms persisted offset if present
5. repeatedly calls `getUpdates`
6. dispatches each update to `bot.handleUpdate(update)`
7. persists update ID only after `handleUpdate` completes
8. restarts the whole polling cycle on stall, recoverable network failure, or `409 getUpdates` conflict

The supervisor replaces `adapter.bot.start()` for runtime polling.

### B. Offset Store

Persist offset state under:

```text
~/.selfagent/telegram/update-offset.json
```

Shape:

```json
{
  "version": 1,
  "lastUpdateId": 123456789,
  "botId": "123456"
}
```

Rules:

- derive `botId` from the token prefix before `:`
- ignore persisted offsets when `botId` does not match the current token
- ignore invalid, negative, or unsafe integer offsets
- write atomically
- only write an update ID after the corresponding handler has completed
- skip any update with `update_id <= lastPersistedUpdateId`

Because SelfAgent's explicit polling loop handles updates sequentially, this phase does not need OpenClaw's pending/failed watermark machinery. If update handling becomes concurrent later, safe watermark tracking must be added before persisting offsets.

### C. Liveness And Timeouts

Defaults:

- `getUpdates` Telegram timeout: `30s`
- local `getUpdates` wall timeout: `45s`
- polling stall threshold: `120s`
- watchdog interval: `30s`
- startup offset confirmation timeout: `10s`
- restart backoff: exponential with jitter, starting at `2s`, capped at `30s`

Config:

```bash
SELFAGENT_TELEGRAM_GET_UPDATES_TIMEOUT_SECONDS=30
SELFAGENT_TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_SECONDS=45
SELFAGENT_TELEGRAM_POLLING_STALL_THRESHOLD_SECONDS=120
SELFAGENT_TELEGRAM_POLLING_WATCHDOG_SECONDS=30
```

The supervisor should abort active polling when:

- process receives shutdown
- watchdog detects stalled polling
- polling cycle is being restarted

### D. Error Handling

Recoverable polling errors:

- `AbortError`
- timeout-like errors
- common network codes: `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `ENETUNREACH`, `EHOSTUNREACH`, `ENOTFOUND`, `EAI_AGAIN`, `UND_ERR_*`
- Telegram `429` should respect `retry_after` when present
- Telegram `5xx` should retry

Non-recoverable errors:

- authentication failures such as `401`
- malformed runtime setup
- handler bugs that escape `bot.catch` and are not isolated

`409 getUpdates`:

- log as conflict
- rebuild adapter/bot
- rerun `deleteWebhook`
- continue from persisted offset

### E. Handler Error Boundary

Install `bot.catch(...)` so middleware errors are logged, then rethrow into the supervisor's per-update error boundary. This prevents a failed middleware run from being treated as successfully handled for offset persistence. Existing message-processing code already catches most asynchronous conversation work inside the queued task.

### F. Logging

Log at minimum:

- polling cycle start/stop
- loaded and persisted offset
- `deleteWebhook` success/failure
- offset confirmation success/failure
- every `getUpdates` error and retry decision
- watchdog stall diagnostics
- restart backoff delay
- non-recoverable polling failures

### G. Compatibility

This change must not alter:

- Telegram commands
- approval callbacks
- message queue semantics
- cron scheduler behavior
- attachment collection
- formatted reply delivery
- model/provider configuration

## Implementation Plan

1. Add polling config fields to `AppConfig`.
2. Add a small Telegram offset store module.
3. Add a Telegram polling supervisor module.
4. Refactor runtime handler registration into a reusable function that can bind handlers to each fresh adapter.
5. Replace `adapter.bot.start()` with the supervisor.
6. Keep cron scheduler outside polling cycle so it survives polling restarts.
7. Run `npm run build`.

## Acceptance Criteria

- `npm run build` passes.
- SelfAgent no longer calls `adapter.bot.start()` in runtime.
- Telegram polling can restart without recreating conversation service caches or stopping cron.
- offset state is written after handled updates.
- duplicate updates at or below persisted offset are skipped.
- stalled polling triggers a logged restart.
- `409 getUpdates` triggers a logged restart and webhook cleanup rerun.

## Known Limitations

- If SelfAgent process crashes after Telegram delivers an update but before handler completion, the update may replay on restart. This is acceptable for phase 1 and safer than skipping uncompleted work.
- Conversation work remains asynchronous after message handler enqueue. A process crash after enqueue but before the queued agent run completes can still lose the reply side effect even though the update handler completed. A stronger design would persist an inbound work queue before acknowledging offset progress.
- This phase does not implement webhook mode.
