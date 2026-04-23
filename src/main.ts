import {
  addChannelCommand,
  addModelCommand,
  authorizeChannelUserCommand,
  printUsage,
  startCommand,
  statusCommand,
  stopCommand
} from "./commands.js";
import { loadConfig } from "./config.js";
import { configureLogger, createLogger } from "./logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const argv = process.argv.slice(2);
  const daemonRequested = (!argv[0] || argv[0] === "start") && argv.includes("--daemon");
  const effectiveLogFile = daemonRequested ? config.logFile ?? `${config.stateRoot}/logs/runtime.log` : config.logFile;
  configureLogger({
    level: config.logLevel,
    filePath: effectiveLogFile,
    maxBytes: config.logMaxBytes,
    maxFiles: config.logMaxFiles
  });
  const logger = createLogger("main");

  const [, , command, subcommand] = process.argv;
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

  if (command === "status") {
    await statusCommand();
    return;
  }

  if (command === "channels" && subcommand === "add") {
    await addChannelCommand();
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

  printUsage();
  process.exitCode = 1;
}

await main();
