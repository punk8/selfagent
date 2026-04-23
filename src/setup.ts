import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { AppConfig } from "./config.js";
import { createLogger } from "./logger.js";

const logger = createLogger("setup");

interface MutableOutput extends Writable {
  muted?: boolean;
}

async function ensureDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

function createMutedOutput(): MutableOutput {
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!output.muted) {
        process.stdout.write(chunk, encoding as BufferEncoding);
      }
      callback();
    }
  }) as MutableOutput;
  output.muted = false;
  return output;
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function promptSecret(question: string): Promise<string> {
  const output = createMutedOutput();
  const rl = createInterface({
    input: process.stdin,
    output
  });
  try {
    output.muted = false;
    process.stdout.write(question);
    output.muted = true;
    const answer = (await rl.question("")).trim();
    output.muted = false;
    process.stdout.write("\n");
    return answer;
  } finally {
    rl.close();
  }
}

async function choose(question: string, options: string[]): Promise<number> {
  for (let i = 0; i < options.length; i += 1) {
    process.stdout.write(`${i + 1}. ${options[i]}\n`);
  }
  while (true) {
    const raw = await prompt(`${question} [1-${options.length}]: `);
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= options.length) {
      return parsed - 1;
    }
    process.stdout.write("Invalid selection.\n");
  }
}

async function saveConfig(config: AppConfig): Promise<void> {
  await ensureDirectory(config.configFile);
  await writeFile(
    config.configFile,
    `${JSON.stringify(
      {
        channel: config.channel,
        telegramBotToken: config.telegramBotToken,
        modelProvider: config.modelProvider,
        modelId: config.modelId,
        thinkingLevel: config.thinkingLevel
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  logger.debug("Persisted interactive config", {
    configFile: config.configFile,
    channel: config.channel,
    modelProvider: config.modelProvider,
    hasTelegramBotToken: Boolean(config.telegramBotToken)
  });
}

async function ensureChannelSelection(config: AppConfig): Promise<void> {
  if (config.channel) {
    logger.info("Using configured channel", { channel: config.channel });
    return;
  }

  process.stdout.write("\nChoose the first channel to configure.\n");
  const selection = await choose("Channel", ["Telegram"]);
  if (selection === 0) {
    config.channel = "telegram";
    await saveConfig(config);
    logger.info("Selected channel", { channel: config.channel });
    return;
  }

  throw new Error("Unsupported channel selection");
}

async function interactiveOauthLogin(authStorage: AuthStorage, providerId: "openai-codex" | "anthropic"): Promise<void> {
  await authStorage.login(providerId, {
    onAuth: (info) => {
      logger.info("OAuth browser step required", { providerId, url: info.url });
      process.stdout.write(`\nOpen this URL in your browser:\n${info.url}\n`);
      if (info.instructions) {
        process.stdout.write(`${info.instructions}\n`);
      }
      process.stdout.write("\n");
    },
    onPrompt: async (oauthPrompt) => {
      const label = oauthPrompt.placeholder ? `${oauthPrompt.message} (${oauthPrompt.placeholder})` : oauthPrompt.message;
      return prompt(`${label}: `);
    },
    onManualCodeInput: async () => {
      return prompt("If needed, paste the final redirect URL or authorization code here, otherwise press Enter to wait: ");
    },
    onProgress: (message) => {
      logger.info("OAuth progress", { providerId, message });
      process.stdout.write(`${message}\n`);
    }
  });
}

async function ensureTelegramBotToken(config: AppConfig): Promise<void> {
  if (config.channel !== "telegram") {
    return;
  }
  if (config.telegramBotToken) {
    logger.info("Using saved Telegram bot token");
    return;
  }
  const token = await promptSecret("Telegram bot token: ");
  if (!token) {
    throw new Error("Telegram bot token is required");
  }
  config.telegramBotToken = token;
  await saveConfig(config);
  logger.info("Telegram bot token saved");
}

async function ensureModelAuth(config: AppConfig): Promise<void> {
  const authStorage = AuthStorage.create(config.authFile);
  const modelRegistry = ModelRegistry.create(authStorage, config.modelsFile);

  if (config.openAiApiKey) {
    authStorage.setRuntimeApiKey("openai", config.openAiApiKey);
    logger.info("Loaded OpenAI runtime API key from environment");
  }
  if (config.anthropicApiKey) {
    authStorage.setRuntimeApiKey("anthropic", config.anthropicApiKey);
    logger.info("Loaded Anthropic runtime API key from environment");
  }

  if (modelRegistry.getAvailable().length > 0) {
    logger.info("Detected existing model authentication", {
      availableModels: modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`)
    });
    return;
  }

  process.stdout.write("\nNo usable model authentication is configured yet.\n");
  const selection = await choose("Choose an auth method", [
    "OpenAI Codex OAuth login",
    "Anthropic OAuth login",
    "OpenAI API key",
    "Anthropic API key",
    "Skip for now"
  ]);

  if (selection === 0) {
    await interactiveOauthLogin(authStorage, "openai-codex");
    config.modelProvider = "openai-codex";
    config.modelId = undefined;
    await saveConfig(config);
    logger.info("OpenAI Codex OAuth login completed");
    return;
  }
  if (selection === 1) {
    await interactiveOauthLogin(authStorage, "anthropic");
    config.modelProvider = "anthropic";
    config.modelId = undefined;
    await saveConfig(config);
    logger.info("Anthropic OAuth login completed");
    return;
  }
  if (selection === 2) {
    const apiKey = await promptSecret("OpenAI API key: ");
    if (!apiKey) {
      throw new Error("OpenAI API key is required");
    }
    authStorage.set("openai", { type: "api_key", key: apiKey });
    config.modelProvider = "openai";
    config.modelId = undefined;
    await saveConfig(config);
    logger.info("OpenAI API key saved");
    return;
  }
  if (selection === 3) {
    const apiKey = await promptSecret("Anthropic API key: ");
    if (!apiKey) {
      throw new Error("Anthropic API key is required");
    }
    authStorage.set("anthropic", { type: "api_key", key: apiKey });
    config.modelProvider = "anthropic";
    config.modelId = undefined;
    await saveConfig(config);
    logger.info("Anthropic API key saved");
    return;
  }

  logger.warn("Skipping auth setup; the agent may fail to start without credentials");
}

export async function ensureInteractiveSetup(config: AppConfig): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (!config.channel) {
      throw new Error("Missing channel selection and no interactive terminal is available");
    }
    if (config.channel === "telegram" && !config.telegramBotToken) {
      throw new Error("Missing TELEGRAM_BOT_TOKEN and no interactive terminal is available");
    }
    return;
  }

  await ensureChannelSelection(config);
  await ensureTelegramBotToken(config);
  await ensureModelAuth(config);
  logger.info("Interactive setup complete", {
    channel: config.channel,
    modelProvider: config.modelProvider
  });
}
