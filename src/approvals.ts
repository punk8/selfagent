import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createLogger } from "./logger.js";
import type { ApprovalRequest, ApprovalState } from "./types.js";

export class ApprovalStore {
  constructor(private readonly filePath: string) {}

  private readonly logger = createLogger("approvals");

  private read(): ApprovalState {
    if (!existsSync(this.filePath)) return {};
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as ApprovalState;
    } catch {
      return {};
    }
  }

  private async write(next: ApprovalState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  getState(): ApprovalState {
    const state = this.read();
    this.logger.debug("Loaded approval state", {
      filePath: this.filePath,
      hasPending: Boolean(state.pending),
      hasSessionGrant: Boolean(state.sessionGrantedAt),
      hasOneTimeGrant: Boolean(state.oneTimeGrantedAt)
    });
    return state;
  }

  async createPending(summary: string, requestedByUserId?: number): Promise<ApprovalRequest> {
    const current = this.read();
    if (current.pending) {
      this.logger.info("Reusing existing pending approval request", {
        filePath: this.filePath,
        requestId: current.pending.requestId
      });
      return current.pending;
    }
    const pending: ApprovalRequest = {
      requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      requestedByUserId,
      summary,
      createdAt: new Date().toISOString()
    };
    await this.write({ ...current, pending });
    this.logger.info("Created pending approval request", {
      filePath: this.filePath,
      requestId: pending.requestId,
      requestedByUserId,
      summary
    });
    return pending;
  }

  async grant(mode: "once" | "session", actorUserId?: number): Promise<ApprovalState> {
    const current = this.read();
    const next: ApprovalState = { ...current, pending: undefined };
    if (mode === "session") {
      next.sessionGrantedToUserId = actorUserId;
      next.sessionGrantedAt = new Date().toISOString();
      next.oneTimeGrantedToUserId = undefined;
      next.oneTimeGrantedAt = undefined;
    } else {
      next.oneTimeGrantedToUserId = actorUserId;
      next.oneTimeGrantedAt = new Date().toISOString();
    }
    await this.write(next);
    this.logger.info("Granted approval", {
      filePath: this.filePath,
      mode,
      actorUserId
    });
    return next;
  }

  async deny(): Promise<void> {
    const current = this.read();
    await this.write({
      ...current,
      pending: undefined,
      oneTimeGrantedToUserId: undefined,
      oneTimeGrantedAt: undefined
    });
    this.logger.info("Denied approval request", { filePath: this.filePath });
  }

  async consumeGrant(actorUserId?: number): Promise<"session" | "once" | undefined> {
    const current = this.read();
    if (current.sessionGrantedToUserId === undefined || current.sessionGrantedToUserId === actorUserId) {
      if (current.sessionGrantedAt) {
        this.logger.debug("Consumed session approval grant", {
          filePath: this.filePath,
          actorUserId
        });
        return "session";
      }
    }
    if (current.oneTimeGrantedAt && (current.oneTimeGrantedToUserId === undefined || current.oneTimeGrantedToUserId === actorUserId)) {
      await this.write({
        ...current,
        oneTimeGrantedToUserId: undefined,
        oneTimeGrantedAt: undefined
      });
      this.logger.info("Consumed one-time approval grant", {
        filePath: this.filePath,
        actorUserId
      });
      return "once";
    }
    this.logger.debug("No approval grant available", { filePath: this.filePath, actorUserId });
    return undefined;
  }
}
