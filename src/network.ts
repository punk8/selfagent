import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { ProxyAgent } from "proxy-agent";
import { createLogger } from "./logger.js";

const logger = createLogger("network");

let proxyConfigured = false;
let nodeHttpProxyAgent: ProxyAgent | undefined;

function getProxyEnvironmentSnapshot(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const key of [
    "https_proxy",
    "HTTPS_PROXY",
    "http_proxy",
    "HTTP_PROXY",
    "all_proxy",
    "ALL_PROXY",
    "no_proxy",
    "NO_PROXY"
  ]) {
    const value = process.env[key]?.trim();
    if (value) {
      snapshot[key] = value;
    }
  }
  return snapshot;
}

export function configureNetwork(): void {
  if (proxyConfigured) {
    return;
  }

  const proxyEnvironment = getProxyEnvironmentSnapshot();
  if (Object.keys(proxyEnvironment).length === 0) {
    return;
  }

  setGlobalDispatcher(new EnvHttpProxyAgent());
  proxyConfigured = true;
  logger.info("Configured global HTTP proxy dispatcher from environment", {
    proxyEnvironment
  });
}

export function getNodeHttpProxyAgent(): ProxyAgent | undefined {
  const proxyEnvironment = getProxyEnvironmentSnapshot();
  if (Object.keys(proxyEnvironment).length === 0) {
    return undefined;
  }
  nodeHttpProxyAgent ??= new ProxyAgent();
  return nodeHttpProxyAgent;
}
