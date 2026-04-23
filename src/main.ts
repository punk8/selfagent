#!/usr/bin/env node

import {
  addChannelCommand,
  addModelCommand,
  authorizeChannelUserCommand,
  listChannelsCommand,
  listModelsCommand,
  onboardCommand,
  printUsage,
  restartCommand,
  removeModelCommand,
  startCommand,
  statusCommand,
  stopCommand,
  upgradeCommand,
  versionCommand
} from "./commands.js";
import { loadConfig } from "./config.js";
import { configureLogger, createLogger } from "./logger.js";
import { configureNetwork } from "./network.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [command, subcommand, ...rest] = argv;

  if (command === "--version" || command === "-v") {
    versionCommand();
    return;
  }

  if (command === "--upgrade" || command === "upgrade") {
    await upgradeCommand();
    return;
  }

  if (command === "onboard") {
    await onboardCommand();
    return;
  }

  const config = loadConfig();
  const daemonRequested = (!argv[0] || argv[0] === "start") && argv.includes("--daemon");
  const effectiveLogFile = daemonRequested ? config.logFile ?? `${config.stateRoot}/logs/runtime.log` : config.logFile;
  configureLogger({
    level: config.logLevel,
    filePath: effectiveLogFile,
    maxBytes: config.logMaxBytes,
    maxFiles: config.logMaxFiles
  });
  configureNetwork();
  const logger = createLogger("main");

  logger.info("SelfAgent CLI invoked", {
    argv,
    workspaceRoot: config.workspaceRoot,
    stateRoot: config.stateRoot,
    logLevel: config.logLevel,
    logFile: effectiveLogFile,
    logMaxBytes: config.logMaxBytes,
    logMaxFiles: config.logMaxFiles
  });

  if (!command || command === "start") {
    await startCommand({ daemon: argv.includes("--daemon") });
    return;
  }

  if (command === "stop") {
    await stopCommand();
    return;
  }

  if (command === "restart") {
    await restartCommand();
    return;
  }

  if (command === "status") {
    await statusCommand();
    return;
  }

  if (command === "channels" && subcommand === "add") {
    await addChannelCommand();
    return;
  }

  if (command === "channels" && subcommand === "list") {
    await listChannelsCommand();
    return;
  }

  if (command === "channels" && subcommand === "authorize-user") {
    await authorizeChannelUserCommand();
    return;
  }

  if (command === "models" && subcommand === "add") {
    await addModelCommand();
    return;
  }

  if (command === "models" && subcommand === "list") {
    await listModelsCommand();
    return;
  }

  if (command === "models" && subcommand === "remove") {
    await removeModelCommand(rest[0]);
    return;
  }

  printUsage();
  process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  const logger = createLogger("main");
  const message = error instanceof Error ? error.message : String(error);
  logger.error("SelfAgent CLI failed", { error: message });
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
