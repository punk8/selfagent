# SelfAgent Session Continuity Spec

## Goal

Make Telegram conversation history persist and resume correctly across turns.

The runtime should:

- continue the most recent persisted session for a conversation
- stop assuming a fixed `session.jsonl` filename
- expose the real active transcript path in logs and prompt context
- avoid misleading the model with a non-existent transcript file path

## Problem

Current SelfAgent behavior assumes each Telegram conversation uses:

- `<conversation-dir>/session.jsonl`

But `pi-coding-agent` does not persist sessions under that fixed filename when using `SessionManager.create(...)`.
It creates timestamped files such as:

- `2026-04-23T16-46-58-859Z_<session-id>.jsonl`

Consequences:

- `exists(paths.sessionFile)` is almost always false
- every turn creates a brand-new session instead of resuming the latest one
- conversation context continuity becomes unreliable
- the system prompt tells the model a transcript file exists at a path that does not exist

## Reference behavior

`pi-coding-agent` already provides the correct primitive:

- `SessionManager.continueRecent(cwd, sessionDir)`

This opens the most recent session file in the directory, or creates a new one when none exists.

## SelfAgent design

### Telegram conversation sessions

For normal Telegram conversations:

- treat the conversation directory as the session directory
- use `SessionManager.continueRecent(workspaceRoot, conversationDir)`
- after the manager is created, read the actual transcript path from `sessionManager.getSessionFile()`

This makes each conversation append to the latest real transcript file.

### Scheduled task runs

Cron runs are isolated and already use a unique run directory.

For cron runs:

- treat the run directory as the session directory
- use `SessionManager.create(workspaceRoot, runDir)`
- log the actual created transcript path from `sessionManager.getSessionFile()`

No resume behavior is needed for isolated cron runs.

## Prompt context

The Telegram system prompt should stop referencing a fake fixed path.

Instead it should expose:

- conversation session directory
- active conversation transcript file, if known

If the transcript file is not yet known, use a neutral placeholder instead of a bogus file path.

## Logging

Agent-turn logs should record the actual session file in use, not a guessed path.

This helps diagnose:

- continuity bugs
- missing transcript bugs
- per-conversation session reuse

## Non-goals

Not required in this change:

- migrating old conversation transcript files
- compacting multiple historical transcript files into one
- changing cron run isolation semantics
- adding transcript cleanup or retention policies

## Verification targets

- repeated Telegram turns in one conversation reuse the latest transcript file
- the conversation directory stops accumulating one new transcript per turn under normal operation
- logs show the actual transcript path being used
- the model no longer receives a non-existent fixed `session.jsonl` path in the Telegram system prompt
