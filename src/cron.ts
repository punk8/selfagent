import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ConversationPaths, ConversationRef } from "./types.js";

export type CronRunStatus = "ok" | "error" | "skipped";

export interface CronOrigin {
  platform: "telegram";
  chatId: number;
  threadId?: number;
  userId?: number;
}

export interface CronScheduleOnce {
  kind: "once";
  runAt: string;
  display: string;
}

export interface CronScheduleInterval {
  kind: "interval";
  everyMinutes: number;
  display: string;
}

export interface CronScheduleCron {
  kind: "cron";
  expr: string;
  display: string;
}

export type CronSchedule = CronScheduleOnce | CronScheduleInterval | CronScheduleCron;

export interface CronJob {
  id: string;
  name: string;
  prompt: string;
  schedule: CronSchedule;
  enabled: boolean;
  skillNames: string[];
  origin: CronOrigin;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: CronRunStatus;
  lastError?: string;
  lastSummary?: string;
  lastDeliveredAt?: string;
  modelProvider?: string;
  modelId?: string;
}

interface CronJobsFile {
  version: 1;
  jobs: CronJob[];
}

export interface CronRunRecord {
  runId: string;
  jobId: string;
  startedAt: string;
  finishedAt: string;
  status: CronRunStatus;
  resultText: string;
  summary: string;
  deliveredMessageIds: number[];
  error?: string;
}

export interface RecentCronDelivery {
  jobId: string;
  jobName: string;
  runId: string;
  deliveredAt: string;
  deliveredMessageIds: number[];
  summary: string;
  resultText: string;
}

export interface CronPaths {
  dir: string;
  jobsFile: string;
  runsDir: string;
}

const DURATION_RE = /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i;
const CRON_FIELD_RE = /^[\d*/,\-]+$/;
const RECENT_CRON_DELIVERIES_LIMIT = 5;

function ensureFiniteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempFile, filePath);
}

function nowIso(): string {
  return new Date().toISOString();
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function parseDurationMinutes(value: string): number | undefined {
  const match = value.trim().match(DURATION_RE);
  if (!match) {
    return undefined;
  }
  const amount = Number.parseInt(match[1] ?? "", 10);
  const unit = (match[2] ?? "").toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }
  if (unit.startsWith("m")) return amount;
  if (unit.startsWith("h")) return amount * 60;
  if (unit.startsWith("d")) return amount * 24 * 60;
  return undefined;
}

function parseIsoTimestamp(value: string): string | undefined {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed.toISOString();
}

function normalizeCronField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  const trimmed = field.trim();
  if (!trimmed || !CRON_FIELD_RE.test(trimmed)) {
    return null;
  }
  if (trimmed === "*") {
    for (let current = min; current <= max; current += 1) {
      values.add(current);
    }
    return values;
  }

  for (const part of trimmed.split(",")) {
    if (!part) {
      return null;
    }
    const slashIndex = part.indexOf("/");
    const [rangePart, stepPart] = slashIndex >= 0 ? [part.slice(0, slashIndex), part.slice(slashIndex + 1)] : [part, ""];
    const step = stepPart ? Number.parseInt(stepPart, 10) : 1;
    if (!Number.isFinite(step) || step <= 0) {
      return null;
    }

    let rangeStart = min;
    let rangeEnd = max;
    if (rangePart && rangePart !== "*") {
      const dashIndex = rangePart.indexOf("-");
      if (dashIndex >= 0) {
        rangeStart = Number.parseInt(rangePart.slice(0, dashIndex), 10);
        rangeEnd = Number.parseInt(rangePart.slice(dashIndex + 1), 10);
      } else {
        rangeStart = Number.parseInt(rangePart, 10);
        rangeEnd = rangeStart;
      }
    }

    if (
      !Number.isFinite(rangeStart) ||
      !Number.isFinite(rangeEnd) ||
      rangeStart < min ||
      rangeEnd > max ||
      rangeStart > rangeEnd
    ) {
      return null;
    }

    for (let current = rangeStart; current <= rangeEnd; current += step) {
      values.add(current);
    }
  }

  return values;
}

function matchesCronExpression(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return false;
  }
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields;
  const minute = normalizeCronField(minuteField ?? "", 0, 59);
  const hour = normalizeCronField(hourField ?? "", 0, 23);
  const day = normalizeCronField(dayField ?? "", 1, 31);
  const month = normalizeCronField(monthField ?? "", 1, 12);
  const weekday = normalizeCronField(weekdayField ?? "", 0, 6);
  if (!minute || !hour || !day || !month || !weekday) {
    return false;
  }
  return (
    minute.has(date.getMinutes()) &&
    hour.has(date.getHours()) &&
    day.has(date.getDate()) &&
    month.has(date.getMonth() + 1) &&
    weekday.has(date.getDay())
  );
}

function computeNextCronOccurrence(expr: string, fromDate: Date): string | undefined {
  const start = new Date(fromDate.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const limit = start.getTime() + 366 * 24 * 60 * 60_000;
  for (let cursor = start.getTime(); cursor <= limit; cursor += 60_000) {
    const candidate = new Date(cursor);
    if (matchesCronExpression(expr, candidate)) {
      return candidate.toISOString();
    }
  }
  return undefined;
}

function generateId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function summarizeCronResult(text: string, maxChars = 280): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(empty result)";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

export function getCronPaths(stateRoot: string): CronPaths {
  const dir = resolve(stateRoot, "cron");
  return {
    dir,
    jobsFile: resolve(dir, "jobs.json"),
    runsDir: resolve(dir, "runs")
  };
}

export function getRecentCronDeliveriesFile(paths: ConversationPaths): string {
  return resolve(paths.dir, "recent-cron-deliveries.json");
}

export function loadCronJobs(stateRoot: string): CronJob[] {
  const store = readJsonFile<CronJobsFile>(getCronPaths(stateRoot).jobsFile, {
    version: 1,
    jobs: []
  });
  return Array.isArray(store.jobs) ? store.jobs : [];
}

export async function saveCronJobs(stateRoot: string, jobs: CronJob[]): Promise<void> {
  await writeJsonFileAtomic(getCronPaths(stateRoot).jobsFile, {
    version: 1,
    jobs
  } satisfies CronJobsFile);
}

export function findCronJob(stateRoot: string, jobId: string): CronJob | undefined {
  return loadCronJobs(stateRoot).find((job) => job.id === jobId);
}

export function parseCronScheduleInput(input: string, now = new Date()): CronSchedule {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Schedule is required");
  }

  if (trimmed.toLowerCase().startsWith("every ")) {
    const minutes = parseDurationMinutes(trimmed.slice(6).trim());
    if (!minutes) {
      throw new Error("Invalid interval schedule. Use values like `every 30m` or `every 2h`.");
    }
    return {
      kind: "interval",
      everyMinutes: minutes,
      display: trimmed
    };
  }

  const relativeMinutes = parseDurationMinutes(trimmed);
  if (relativeMinutes) {
    return {
      kind: "once",
      runAt: addMinutes(now, relativeMinutes).toISOString(),
      display: trimmed
    };
  }

  if (trimmed.split(/\s+/).length === 5 && trimmed.split(/\s+/).every((field) => CRON_FIELD_RE.test(field))) {
    if (!computeNextCronOccurrence(trimmed, now)) {
      throw new Error("Invalid cron expression or no future run could be computed.");
    }
    return {
      kind: "cron",
      expr: trimmed,
      display: trimmed
    };
  }

  const runAt = parseIsoTimestamp(trimmed);
  if (runAt) {
    return {
      kind: "once",
      runAt,
      display: trimmed
    };
  }

  throw new Error(
    "Invalid schedule. Use `30m`, `every 2h`, a five-field cron expression like `0 9 * * *`, or an ISO timestamp."
  );
}

export function computeCronJobNextRunAt(job: CronJob, now = new Date()): string | undefined {
  if (!job.enabled) {
    return undefined;
  }
  if (job.schedule.kind === "once") {
    const runAt = new Date(job.schedule.runAt);
    if (Number.isNaN(runAt.getTime())) {
      return undefined;
    }
    if (job.lastRunAt) {
      return undefined;
    }
    return runAt.toISOString();
  }
  if (job.schedule.kind === "interval") {
    const anchor = job.lastRunAt ? new Date(job.lastRunAt) : new Date(job.createdAt);
    const next = addMinutes(anchor, ensureFiniteNumber(job.schedule.everyMinutes, 0));
    if (next.getTime() <= now.getTime()) {
      const driftMinutes = Math.floor((now.getTime() - anchor.getTime()) / 60_000);
      const steps = Math.max(1, Math.floor(driftMinutes / job.schedule.everyMinutes) + 1);
      return addMinutes(anchor, steps * job.schedule.everyMinutes).toISOString();
    }
    return next.toISOString();
  }
  return computeNextCronOccurrence(job.schedule.expr, now);
}

export function isCronJobDue(job: CronJob, now = new Date()): boolean {
  if (!job.enabled || !job.nextRunAt) {
    return false;
  }
  const nextRunAt = new Date(job.nextRunAt);
  if (Number.isNaN(nextRunAt.getTime())) {
    return false;
  }
  return nextRunAt.getTime() <= now.getTime();
}

export function createCronJob(params: {
  name: string;
  prompt: string;
  scheduleInput: string;
  skillNames?: string[];
  origin: CronOrigin;
  modelProvider?: string;
  modelId?: string;
}): CronJob {
  const createdAt = nowIso();
  const schedule = parseCronScheduleInput(params.scheduleInput, new Date(createdAt));
  const job: CronJob = {
    id: generateId("cron"),
    name: params.name.trim(),
    prompt: params.prompt.trim(),
    schedule,
    enabled: true,
    skillNames: [...new Set((params.skillNames ?? []).map((name) => name.trim()).filter(Boolean))],
    origin: params.origin,
    createdAt,
    updatedAt: createdAt,
    modelProvider: params.modelProvider?.trim() || undefined,
    modelId: params.modelId?.trim() || undefined
  };
  job.nextRunAt = computeCronJobNextRunAt(job, new Date(createdAt));
  return job;
}

export function updateCronJob(job: CronJob, patch: Partial<CronJob>): CronJob {
  const next: CronJob = {
    ...job,
    ...patch,
    updatedAt: nowIso()
  };
  next.skillNames = [...new Set((next.skillNames ?? []).map((name) => name.trim()).filter(Boolean))];
  next.nextRunAt = computeCronJobNextRunAt(next);
  return next;
}

export async function appendCronRunRecord(
  stateRoot: string,
  jobId: string,
  runId: string,
  record: CronRunRecord
): Promise<string> {
  const runDir = resolve(getCronPaths(stateRoot).runsDir, jobId, runId);
  await mkdir(runDir, { recursive: true });
  const recordFile = resolve(runDir, "record.json");
  await writeJsonFileAtomic(recordFile, record);
  return recordFile;
}

export function createCronRunPaths(stateRoot: string, jobId: string, runId: string) {
  const dir = resolve(getCronPaths(stateRoot).runsDir, jobId, runId);
  return {
    dir,
    sessionFile: resolve(dir, "session.jsonl"),
    attachmentsDir: resolve(dir, "attachments"),
    scratchDir: resolve(dir, "scratch")
  };
}

export function createCronRunId(): string {
  return generateId("run");
}

export function loadRecentCronDeliveries(paths: ConversationPaths): RecentCronDelivery[] {
  const filePath = getRecentCronDeliveriesFile(paths);
  const items = readJsonFile<RecentCronDelivery[]>(filePath, []);
  return Array.isArray(items) ? items : [];
}

export async function appendRecentCronDelivery(
  paths: ConversationPaths,
  delivery: RecentCronDelivery
): Promise<void> {
  const current = loadRecentCronDeliveries(paths);
  const next = [delivery, ...current].slice(0, RECENT_CRON_DELIVERIES_LIMIT);
  await writeJsonFileAtomic(getRecentCronDeliveriesFile(paths), next);
}

export function formatRecentCronDeliveriesForPrompt(items: RecentCronDelivery[]): string {
  if (items.length === 0) {
    return "(none)";
  }
  return items
    .map((item, index) =>
      [
        `${index + 1}. job=${item.jobName} jobId=${item.jobId} runId=${item.runId}`,
        `   deliveredAt=${item.deliveredAt} messageIds=${item.deliveredMessageIds.join(",") || "(none)"}`,
        `   summary=${summarizeCronResult(item.summary, 220)}`
      ].join("\n")
    )
    .join("\n");
}

export function describeCronOrigin(conversation: ConversationRef): CronOrigin {
  return {
    platform: "telegram",
    chatId: conversation.chatId,
    threadId: conversation.threadId,
    userId: conversation.userId
  };
}
