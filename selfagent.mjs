#!/usr/bin/env node

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const [major = "0", minor = "0"] = process.versions.node.split(".");
const majorVersion = Number.parseInt(major, 10);
const minorVersion = Number.parseInt(minor, 10);

if (
  !Number.isFinite(majorVersion) ||
  !Number.isFinite(minorVersion) ||
  majorVersion < 20 ||
  (majorVersion === 20 && minorVersion < 10)
) {
  process.stderr.write(`SelfAgent requires Node.js >= 20.10.0. Current version: ${process.version}\n`);
  process.exit(1);
}

const entry = join(dirname(fileURLToPath(import.meta.url)), "dist", "main.js");
if (!existsSync(entry)) {
  process.stderr.write(
    [
      "SelfAgent build output is missing.",
      "If you are running from a source checkout, run `npm install` and `npm run build` first."
    ].join("\n") + "\n"
  );
  process.exit(1);
}

await import(pathToFileURL(entry).href);
