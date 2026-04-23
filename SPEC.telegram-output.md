# Telegram Output Formatting And Streaming Spec

## Summary

This spec defines the first Telegram output upgrade for `selfagent`.

The goal is to move from:

- plain text final-only replies
- naive text chunk splitting

to:

- Telegram-aware formatted text output
- progressive streamed reply previews while the model is generating
- safe fallback behavior when Telegram formatting fails

The implementation should follow the practical direction used by `openclaw` for Telegram delivery, while intentionally starting with a smaller scope that fits the current `selfagent` architecture.

## Why This Change

Current `selfagent` behavior:

- accumulates `text_delta` events into a string
- waits for the turn to finish
- sends one final plain text reply through `TelegramAdapter.sendText`

Current gaps:

- Markdown/code/quotes/spoilers are not rendered for Telegram
- long replies are split by raw character count only
- users do not see streamed progress, only a typing indicator
- Telegram parsing and formatting failures cannot fall back intelligently

## Reference Findings

### OpenClaw

Relevant behavior:

- converts markdown-like content into Telegram HTML
- uses Telegram-safe chunking that preserves tag and entity boundaries
- sends formatted HTML with plain-text fallback on parse failure
- supports preview streaming via message send + edit flow
- has a more advanced draft/materialize path that is not required for phase 1

Important reference files:

- `.tmp/openclaw/extensions/telegram/src/format.ts`
- `.tmp/openclaw/extensions/telegram/src/bot/delivery.send.ts`
- `.tmp/openclaw/extensions/telegram/src/bot/delivery.replies.ts`
- `.tmp/openclaw/extensions/telegram/src/draft-stream.ts`
- `.tmp/openclaw/extensions/telegram/src/preview-streaming.ts`

### Hermes-Agent

Relevant behavior:

- converts markdown into Telegram MarkdownV2
- progressively edits a single message during streaming
- falls back to plain text on format parse failure

Important reference files:

- `.tmp/hermes-agent/gateway/platforms/telegram.py`
- `.tmp/hermes-agent/gateway/stream_consumer.py`

## Design Choice

Phase 1 will follow `openclaw`'s output direction:

- use Telegram HTML, not MarkdownV2
- format text before sending/editing
- maintain a plain-text fallback for Telegram parse failures

Phase 1 streaming will use the simpler transport shape:

- send initial preview message
- edit that same message during generation
- finalize it when generation completes

This intentionally does **not** include `openclaw`'s draft preview / materialize path yet.

## Goals

1. Render common assistant markdown into Telegram HTML.
2. Stream reply previews to Telegram while model text deltas arrive.
3. Preserve a plain-text fallback if Telegram rejects formatted HTML.
4. Keep outbound attachment behavior unchanged.
5. Keep the runtime architecture simple and compatible with future upgrades.

## Non-Goals

Not required in this phase:

- Telegram draft preview / materialize transport
- tool-progress streaming lanes
- reasoning lane separation
- inline button streaming updates
- full markdown feature parity with `openclaw`
- editing previously sent multi-chunk final messages

## Current Integration Points

Current files involved:

- `src/session.ts`
  - subscribes to `AgentSessionEvent`
  - accumulates text deltas
  - returns final reply string only
- `src/runtime.ts`
  - starts typing loop
  - waits for `runConversationTurn(...)`
  - sends final `adapter.sendText(...)`
- `src/telegram.ts`
  - only supports plain text send and raw text chunking

## Proposed Architecture

### A. Telegram Formatter Module

Add a dedicated formatter module for Telegram text output.

Proposed file:

- `src/telegram-format.ts`

Responsibilities:

- convert assistant markdown-ish text into Telegram HTML
- escape HTML text safely
- support a focused formatting subset:
  - bold
  - italic
  - strikethrough
  - inline code
  - fenced code block
  - spoiler
  - blockquote
  - markdown links
- expose safe HTML chunk splitting
- expose plain-text fallback conversion

Phase-1 formatter does not need a full markdown parser. It may implement a focused transform pipeline modeled after the subset that matters most for agent replies.

### B. Telegram Outbound Send/Edit Layer

Extend `TelegramAdapter` so Telegram delivery can:

- send formatted text as HTML
- edit an existing Telegram message using HTML
- fall back to plain text if HTML parse fails
- split long HTML safely at Telegram message limits

Proposed new adapter methods:

- `sendFormattedText(...)`
- `sendFormattedPreview(...)`
- `editFormattedPreview(...)`
- `finalizeFormattedPreview(...)`

These methods should:

- prefer `parse_mode: "HTML"`
- keep a `plainText` fallback
- retry in plain text when Telegram rejects formatting
- keep preview streaming limited to a single mutable message until finalization

### C. Streamed Reply Session Callback

`runConversationTurn(...)` should stop being "final string only".

Instead, it should accept optional streamed output callbacks:

- `onTextDelta(delta)`
- `onFinalText(text)`

The session code will still subscribe to `AgentSessionEvent`, but when `text_delta` events arrive it will forward them immediately through the callback.

### D. Runtime Preview Controller

`src/runtime.ts` should create a lightweight preview controller per turn:

- no preview message exists at turn start
- once enough text has accumulated, send a first preview message
- periodically edit that preview while new deltas arrive
- on completion, do one final flush

Behavioral rules:

- keep typing indicator loop
- throttle preview edits to avoid Telegram spam / rate pressure
- do not send whitespace-only preview text
- if preview send/edit fails, fall back to the old final-only send path

## Streaming Behavior

### Preview Threshold

Do not send a preview message for tiny early deltas.

Initial defaults:

- minimum chars before first preview: `48`
- edit throttle interval: `1000ms`

Rationale:

- avoids noisy empty or trivial preview pushes
- keeps implementation simple and close to `openclaw`'s throttled preview approach

### Message Limit

Telegram text messages are limited to roughly 4096 characters.

Phase 1 behavior:

- preview stream edits only target the first message
- if final text exceeds the safe limit, finalize by replacing the preview with the first chunk and sending overflow as follow-up chunks

Implementation simplification:

- preview transport owns only one mutable message id
- final delivery may still use chunked sends for overflow

## Failure Handling

### Formatting Failure

If Telegram rejects the HTML payload:

- retry with plain text
- continue the turn successfully if plain text succeeds

### Preview Failure

If preview send/edit fails:

- stop further preview edits for that turn
- keep collecting final text
- send the final reply using the normal final delivery path

### Empty Output

If formatting produces empty HTML:

- use plain text fallback

## Proposed File Changes

### New Files

- `src/telegram-format.ts`
- `src/telegram-stream.ts`
  - small preview state machine / throttled updater

### Existing Files

- `src/telegram.ts`
  - add formatted send/edit methods
- `src/session.ts`
  - support streamed callbacks from model events
- `src/runtime.ts`
  - create and drive preview stream during a turn

## API Shape

### `src/session.ts`

Add optional callbacks:

```ts
runConversationTurn(
  services,
  conversation,
  userText,
  attachments,
  {
    onTextDelta?: (delta: string) => Promise<void> | void,
    onFinalText?: (text: string) => Promise<void> | void
  }
): Promise<string>
```

### `src/telegram.ts`

Add:

```ts
sendFormattedText(chatId, markdownText, threadId?)
editFormattedText(chatId, messageId, markdownText, threadId?)
```

Both methods should internally:

- render HTML + plain text fallback
- use safe chunking / edit behavior

### `src/telegram-stream.ts`

Add a small controller with methods like:

```ts
update(text: string): Promise<void>
flush(): Promise<void>
stop(): Promise<void>
messageId(): number | undefined
```

## Migration Strategy

1. Add formatter and formatted adapter methods.
2. Switch final reply sending from plain text to formatted text.
3. Add runtime preview stream controller.
4. Wire `runConversationTurn` deltas into that controller.
5. Verify fallbacks on format and network errors.

## Verification

Minimum verification:

- unit-like validation for formatter edge cases
- `npm run build`
- live startup verification still succeeds
- formatted replies send successfully to Telegram
- long replies are chunked safely
- streaming edits appear during generation and finalize cleanly

## Future Extensions

Once phase 1 is stable, likely follow-ups are:

- `draft` preview transport and `materialize`
- better block-aware chunking
- stream segmentation around tool/progress boundaries
- richer file-reference handling
- stronger markdown compatibility
