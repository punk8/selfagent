# SelfAgent Cron Task Spec

## Goal

Add a Telegram-first scheduled task system to SelfAgent that can:

- create scheduled tasks from the CLI and from normal agent conversations
- run tasks on a schedule without relying on system crontab
- load workspace and conversation skills during task execution
- deliver the final result back to the originating channel
- let later user follow-up questions reference recent cron-delivered results

This feature should stay aligned with the current SelfAgent architecture:

- Telegram is the only channel for phase 1 delivery
- scheduled runs are isolated from the main conversation session transcript
- skill loading continues to reuse the existing `pi-coding-agent` skill mechanism
- dangerous tools such as `computer_use` remain blocked for unattended cron runs

## Non-goals

Not required for phase 1:

- multi-channel cron delivery beyond Telegram
- external triggers such as webhooks or Gmail PubSub
- persistent cron-specific long-lived chat sessions
- advanced failure routing or alert fan-out
- arbitrary cron job scripts
- automatic computer-use execution in cron jobs

## References

Design direction combines:

- Hermes-style cron jobs for simple persisted schedules, fresh isolated execution, and skill-backed jobs
- OpenClaw-style origin delivery semantics so jobs created from Telegram notify back to the same Telegram conversation

## User model

There are two surfaces for cron tasks:

1. CLI management
   - `selfagent cron add`
   - `selfagent cron list`
   - `selfagent cron pause <job-id>`
   - `selfagent cron resume <job-id>`
   - `selfagent cron run <job-id>`
   - `selfagent cron remove <job-id>`

2. Agent tool management
   - a custom `cron_task` tool lets the model create and manage tasks during Telegram conversations
   - when created from Telegram, the current Telegram conversation becomes the task origin automatically

## Core semantics

### 1. Scheduled runs are isolated

Each cron firing executes in a fresh run context:

- separate session transcript
- separate scratch directory
- no reuse of the normal Telegram conversation `session.jsonl`

The task run may still read:

- workspace memory
- conversation memory for the bound Telegram conversation
- selected skills
- recent cron delivery summaries for that conversation

### 2. Delivery binds to origin

Each job stores an origin binding:

- platform: `telegram`
- chat id
- thread id if present
- user id if known

When the task completes, SelfAgent delivers the result back to that origin conversation.

### 3. Follow-up lives in the main conversation

Scheduled runs are isolated, but their delivered results are indexed into the origin conversation state.

Normal Telegram conversation turns can see recent delivered cron results through prompt context. This lets the user ask follow-up questions such as:

- "expand the second item from the report you just sent"
- "why did this task say there were no changes yesterday"

This is not the same as sharing one physical session transcript. It is result linkage, not session reuse.

## Persistence layout

Cron data lives under `~/.selfagent/cron/`.

Files:

- `jobs.json`
  - task definitions
- `runs/<job-id>/<run-id>.json`
  - execution records
- `runs/<job-id>/<run-id>/`
  - isolated run workspace, transcript, scratch

Conversation-linked cron delivery state lives under the Telegram conversation directory:

- `recent-cron-deliveries.json`

This avoids mixing hot runtime state into `config.toml`.

## Data model

### CronJob

Required fields:

- `id`
- `name`
- `prompt`
- `schedule`
- `enabled`
- `skillNames`
- `origin`
- `createdAt`
- `updatedAt`

Optional fields:

- `modelProvider`
- `modelId`
- `lastRunAt`
- `nextRunAt`
- `lastStatus`
- `lastError`
- `lastSummary`
- `lastDeliveredAt`

### CronSchedule

Supported schedule forms:

- one-shot relative delay: `30m`, `2h`, `1d`
- recurring interval: `every 30m`, `every 2h`
- cron expression: `0 9 * * *`
- absolute timestamp: ISO-8601

Canonical stored form:

- `kind = "once" | "interval" | "cron"`
- `runAt` for once
- `everyMinutes` for interval
- `expr` for cron
- `display` original display string

### CronOrigin

- `platform = "telegram"`
- `chatId`
- `threadId?`
- `userId?`

### CronRunRecord

- `runId`
- `jobId`
- `startedAt`
- `finishedAt`
- `status = "ok" | "error" | "skipped"`
- `resultText`
- `summary`
- `deliveredMessageIds`
- `error`
- `artifacts`

### RecentCronDelivery

- `jobId`
- `jobName`
- `runId`
- `deliveredAt`
- `deliveredMessageIds`
- `summary`
- `resultText`

Only the most recent small window should be retained per conversation, for example the latest 5 deliveries.

## Scheduler model

The scheduler runs inside the existing daemonized SelfAgent process.

Behavior:

- start when `selfagent start` launches the Telegram runtime
- perform an immediate tick on startup
- tick on a fixed interval, default 30 seconds
- detect due jobs by comparing `nextRunAt` with current time
- execute jobs serially inside the scheduler loop for phase 1
- recompute `nextRunAt` after each run

No dependency on OS-level crontab, launchd, or systemd timers is required.

## Execution model

### Cron run inputs

Each scheduled run builds its prompt from:

1. cron runtime guidance
2. workspace memory
3. conversation memory for the origin conversation
4. selected workspace and conversation skills
5. recent cron deliveries for the origin conversation
6. the job prompt

### Tool policy

Cron runs can use:

- normal file/system tools from the underlying agent runtime
- `attach`

Cron runs cannot use:

- `computer_use`
- `cron_task`

Reason:

- unattended scheduled runs must not self-schedule recursively
- unattended scheduled runs must not perform local desktop actions

### Skill resolution

For a cron job bound to a Telegram conversation:

- load workspace skills from `${workspaceRoot}/skills`
- load conversation skills from `<conversation>/skills`
- filter to the job's requested `skillNames`

If a requested skill is missing, record it in the run result and continue with the remaining skills.

## Delivery model

Phase 1 delivery is Telegram-only.

Rules:

- if the run finishes with non-empty final text, send it to the origin conversation
- if the run uses `attach`, attachments go to the same origin conversation
- if final text delivery fails, record the failure in the run record and job state

Formatting:

- reuse the current Telegram HTML formatter and chunking logic
- reuse the same send/edit/finalize delivery adapter capabilities already present for interactive replies

## Follow-up semantics

When a cron result is delivered:

- append a compact record to `recent-cron-deliveries.json` for that conversation
- include the latest recent cron deliveries in the normal Telegram system prompt

This gives the main conversation enough context to answer follow-up questions without sharing the scheduled run transcript.

Phase 1 does not require exact reply-to-message resolution. A later phase can improve this by mapping Telegram `reply_to_message_id` to a specific cron delivery record.

## CLI behavior

### `selfagent cron add`

Interactive prompts:

- name
- schedule
- prompt
- comma-separated skill names
- optional model override

Origin behavior:

- CLI-created jobs do not have an automatic Telegram origin unless one is explicitly provided
- phase 1 CLI creation therefore requires either:
  - an existing default Telegram channel profile plus explicit target prompt later, or
  - a manual origin selection flow

For phase 1 implementation, the primary creation path for origin-bound jobs is the `cron_task` agent tool inside Telegram.

### `selfagent cron list`

Show:

- id
- name
- schedule
- enabled
- next run
- last status
- origin summary
- skills

### `selfagent cron pause/resume/remove/run`

Operate on job id.

`run` should enqueue or immediately execute one manual run through the same isolated execution path.

## Agent tool behavior

Add a `cron_task` tool with actions:

- `add`
- `list`
- `pause`
- `resume`
- `remove`
- `run`

When invoked from a Telegram conversation:

- `add` stores the current conversation as the origin
- `list` defaults to jobs bound to the current origin conversation, while still allowing all-jobs listing later if needed

The tool should return concise, user-facing confirmations so the agent can naturally explain what happened.

## Logging and observability

Record:

- scheduler startup
- due jobs found
- run start and finish
- delivery success/failure
- missing skill names

Persist per-run execution metadata under `~/.selfagent/cron/runs/`.

## Verification targets

Phase 1 is complete when:

1. a Telegram user can ask the agent to create a daily task
2. the task persists across restarts
3. the daemon fires the task on schedule
4. the run can load selected skills
5. the final result is delivered back into the same Telegram chat/thread
6. a later user follow-up in the same Telegram conversation can reference the recent cron result
