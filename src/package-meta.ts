import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageMeta {
  name?: string;
  version?: string;
}

function getPackageJsonPath(): string {
  return fileURLToPath(new URL("../package.json", import.meta.url));
}

function loadPackageMeta(): PackageMeta {
  try {
    return JSON.parse(readFileSync(getPackageJsonPath(), "utf8")) as PackageMeta;
  } catch {
    return {};
  }
}

export function getSelfAgentVersion(): string {
  return loadPackageMeta().version?.trim() || "0.0.0";
}

export function getSelfAgentPackageRoot(): string {
  return dirname(getPackageJsonPath());
}

export function detectInstallMode(): "npx" | "installed" | "dev" {
  const normalized = getSelfAgentPackageRoot().replace(/\\/g, "/");
  if (normalized.includes("/_npx/")) {
    return "npx";
  }
  if (normalized.includes("/node_modules/selfagent")) {
    return "installed";
  }
  return "dev";
}
