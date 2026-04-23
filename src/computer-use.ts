import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "./logger.js";
import type { ComputerUseRequest } from "./types.js";

const execFileAsync = promisify(execFile);
const logger = createLogger("computer-use");

const KEY_CODES: Record<string, number> = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  escape: 53,
  esc: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126
};

function ensureMacOs(): void {
  if (process.platform !== "darwin") {
    throw new Error("computer_use is currently implemented only for macOS hosts");
  }
}

function quoteAppleScriptText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function executeComputerUse(request: ComputerUseRequest): Promise<string> {
  ensureMacOs();
  logger.info("Executing computer-use request", {
    action: request.action,
    summary: request.summary,
    app: request.app,
    url: request.url,
    key: request.key,
    textLength: request.text?.length
  });

  switch (request.action) {
    case "open_app": {
      if (!request.app) throw new Error("computer_use open_app requires app");
      await execFileAsync("open", ["-a", request.app]);
      return `Opened app: ${request.app}`;
    }
    case "open_url": {
      if (!request.url) throw new Error("computer_use open_url requires url");
      await execFileAsync("open", [request.url]);
      return `Opened URL: ${request.url}`;
    }
    case "type_text": {
      if (!request.text) throw new Error("computer_use type_text requires text");
      await execFileAsync("osascript", [
        "-e",
        `tell application "System Events" to keystroke "${quoteAppleScriptText(request.text)}"`
      ]);
      return "Typed text into the frontmost application";
    }
    case "press_key": {
      if (!request.key) throw new Error("computer_use press_key requires key");
      const key = request.key.trim().toLowerCase();
      const code = KEY_CODES[key];
      if (code === undefined) {
        if (key.length === 1) {
          await execFileAsync("osascript", ["-e", `tell application "System Events" to keystroke "${quoteAppleScriptText(key)}"`]);
          return `Pressed key: ${request.key}`;
        }
        throw new Error(`Unsupported key for computer_use: ${request.key}`);
      }
      await execFileAsync("osascript", ["-e", `tell application "System Events" to key code ${code}`]);
      return `Pressed key: ${request.key}`;
    }
    default: {
      const exhaustive: never = request.action;
      throw new Error(`Unsupported computer_use action: ${exhaustive}`);
    }
  }
}
