import type { Bindings } from "../types";

type SfuRoute = {
  method: "POST" | "PUT";
  sessionId?: string;
};

const sfuRoutes: Array<{
  pattern: RegExp;
  method: SfuRoute["method"];
}> = [
  { pattern: /^\/sessions\/new$/, method: "POST" },
  {
    pattern: /^\/sessions\/([A-Za-z0-9_-]+)\/datachannels\/establish$/,
    method: "POST",
  },
  {
    pattern: /^\/sessions\/([A-Za-z0-9_-]+)\/renegotiate$/,
    method: "PUT",
  },
  {
    pattern: /^\/sessions\/([A-Za-z0-9_-]+)\/datachannels\/new$/,
    method: "POST",
  },
];

export function matchSfuRoute(path: string, method: string): SfuRoute | null {
  for (const route of sfuRoutes) {
    const match = route.method === method ? route.pattern.exec(path) : null;
    if (match) return { method: route.method, sessionId: match[1] };
  }
  return null;
}

export function parseSfuRemoteSessionIds(body: string, path: string): string[] | null {
  let value: unknown;
  try {
    value = JSON.parse(body || "{}");
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  if (path.endsWith("/datachannels/new")) {
    if (!Array.isArray(request.dataChannels) || request.dataChannels.length === 0) return null;
    for (const channel of request.dataChannels) {
      if (!channel || typeof channel !== "object" || Array.isArray(channel)) return null;
      const entry = channel as Record<string, unknown>;
      if (entry.location !== "local" && entry.location !== "remote") return null;
      if (entry.location === "remote" && typeof entry.sessionId !== "string") return null;
      if (entry.location === "local" && entry.sessionId !== undefined) return null;
    }
  }
  if (path.endsWith("/datachannels/establish")) {
    const channel = request.dataChannel;
    if (!channel || typeof channel !== "object" || Array.isArray(channel)) return null;
    const entry = channel as Record<string, unknown>;
    // This is the SFU's bootstrap channel, not a remote user publication.
    if (entry.location !== "remote" || entry.dataChannelName !== "server-events" || entry.sessionId !== undefined) return null;
  }

  // Every sessionId in an SFU request body names a remote session. Check all
  // references, including batched channels, before forwarding any operation.
  const remoteSessionIds = new Set<string>();
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item || typeof item !== "object") continue;
    for (const [key, entry] of Object.entries(item)) {
      if (key === "sessionId") {
        if (typeof entry !== "string" || !/^[A-Za-z0-9_-]+$/.test(entry)) return null;
        remoteSessionIds.add(entry);
      } else if (entry && typeof entry === "object") {
        pending.push(entry);
      }
    }
  }
  return [...remoteSessionIds];
}

export async function proxySfuRequest(env: Bindings, path: string, method: SfuRoute["method"], body: string) {
  return fetch(
    `https://rtc.live.cloudflare.com/v1/apps/${encodeURIComponent(env.SFU_APP_ID)}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${env.SFU_APP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: body || undefined,
    },
  );
}
