import { apiJson } from "../../../lib/api/client";

export type CloudflareTurnResponse = {
  iceServers?: unknown;
  expiresAt?: string;
};

export function normalizeIceServers(value: unknown): RTCIceServer[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const server = item as Record<string, unknown>;
    const urls = server.urls;
    const normalizedUrls =
      typeof urls === "string"
        ? urls
        : Array.isArray(urls) && urls.every((url) => typeof url === "string")
          ? urls
          : null;
    if (!normalizedUrls) return [];

    return [{
      urls: normalizedUrls,
      username: typeof server.username === "string" ? server.username : undefined,
      credential: typeof server.credential === "string" ? server.credential : undefined,
    }];
  });
}

export async function generateCloudflareTurnIceServers(
  ttlSeconds: number,
  options: { signal?: AbortSignal } = {},
) {
  const data = await apiJson<CloudflareTurnResponse>("/v1/turn/credentials", "POST", {
    ttlSeconds,
  }, { signal: options.signal });
  const iceServers = normalizeIceServers(data.iceServers);
  if (iceServers.length === 0) throw new Error("Cloudflare 响应里没有可用的 iceServers。");
  return iceServers;
}
