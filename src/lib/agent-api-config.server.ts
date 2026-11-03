type AgentApiEnvironment = Record<string, string | undefined>;

export const DEFAULT_AGENT_API_PATH = "/ag-ui/agent";
export const STS_BROKER_PATH = "/v1/sts";

function originFrom(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!url.protocol.startsWith("http") || url.username || url.password || url.search || url.hash) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function endpointFrom(origin: string, path: string): string | undefined {
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) return undefined;
  try {
    return new URL(path, origin).toString();
  } catch {
    return undefined;
  }
}

/** Resolve the AG-UI endpoint from the deployment-owned base/path settings. */
export function resolveAgentApiUrl(env: AgentApiEnvironment = process.env): string | undefined {
  const origin = originFrom(env.AGENT_API_BASE_URL);
  return origin ? endpointFrom(origin, env.AGENT_API_PATH || DEFAULT_AGENT_API_PATH) : undefined;
}

/** Explicit broker URL wins; otherwise STS lives on the same AgentCore gateway. */
export function resolveStsBrokerUrl(env: AgentApiEnvironment = process.env): string | undefined {
  if (env.STS_BROKER_URL) return env.STS_BROKER_URL;
  const origin = originFrom(env.AGENT_API_BASE_URL);
  return origin ? endpointFrom(origin, STS_BROKER_PATH) : undefined;
}
