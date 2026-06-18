export type CloudflareTurnResponse = {
  iceServers?: unknown;
  errors?: Array<{ message?: string }>;
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

    return [
      {
        urls: normalizedUrls,
        username: typeof server.username === "string" ? server.username : undefined,
        credential: typeof server.credential === "string" ? server.credential : undefined,
      },
    ];
  });
}

export async function generateCloudflareTurnIceServers(keyId: string, apiToken: string, ttl: number) {
  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl }),
    },
  );
  const data = (await response.json().catch(() => ({}))) as CloudflareTurnResponse;
  if (!response.ok) {
    const message = data.errors?.map((error) => error.message).filter(Boolean).join("；");
    throw new Error(message || `Cloudflare TURN 凭证生成失败：HTTP ${response.status}`);
  }

  const iceServers = normalizeIceServers(data.iceServers);
  if (iceServers.length === 0) {
    throw new Error("Cloudflare 响应里没有可用的 iceServers。");
  }
  return iceServers;
}
