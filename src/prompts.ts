import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

interface MutableOutput extends Writable {
  muted?: boolean;
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

export function ensureInteractiveTerminal(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("This command requires an interactive terminal");
  }
}

export async function prompt(question: string): Promise<string> {
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

export async function promptWithDefault(question: string, defaultValue: string): Promise<string> {
  const answer = await prompt(`${question} [${defaultValue}]: `);
  return answer || defaultValue;
}

export async function promptSecret(question: string): Promise<string> {
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

export async function choose(question: string, options: string[]): Promise<number> {
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

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  while (true) {
    const answer = (await prompt(`${question} ${hint}: `)).trim().toLowerCase();
    if (!answer) {
      return defaultYes;
    }
    if (answer === "y" || answer === "yes") {
      return true;
    }
    if (answer === "n" || answer === "no") {
      return false;
    }
    process.stdout.write("Please answer y or n.\n");
  }
}
