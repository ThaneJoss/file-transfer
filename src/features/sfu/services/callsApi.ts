import { API_BASE_URL, apiRequest } from "../../../lib/api/client";

export type AsyncControl = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type CallsSession = {
  id: string;
  peerConnection: RTCPeerConnection;
};

type DataChannelObject = {
  id?: number;
  dataChannelName?: string;
  location?: "local" | "remote";
  sessionId?: string;
  errorCode?: string;
  errorDescription?: string;
};

export type CallsApiResponse = {
  errorCode?: string;
  errorDescription?: string;
  sessionId?: string;
  sessionDescription?: RTCSessionDescriptionInit;
  requiresImmediateRenegotiation?: boolean;
  dataChannel?: DataChannelObject;
  dataChannels?: DataChannelObject[];
  datachannels?: DataChannelObject[];
};

const defaultRequestTimeoutMs = 15_000;

export const callsApiOrigin = `${API_BASE_URL}/v1/sfu`;

/**
 * Calls API requests always go through the authenticated first-party proxy.
 * The browser never receives the Cloudflare app token.
 */
export async function callsFetch(
  path: string,
  init: RequestInit = {},
  control: AsyncControl = {},
) {
  const timeoutMs = normalizeTimeout(control.timeoutMs, defaultRequestTimeoutMs);
  const scope = createAbortScope(control.signal ?? init.signal ?? undefined, timeoutMs);
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");

  try {
    const data = await apiRequest<CallsApiResponse>(`/v1/sfu${normalizeCallsPath(path)}`, {
      ...init,
      headers,
      signal: scope.signal,
    });
    const message = data.errorDescription || data.errorCode;
    if (data.errorCode) {
      throw new Error(message || "Cloudflare Realtime API 请求失败。");
    }
    return data;
  } catch (error) {
    if (scope.didTimeout()) {
      throw new Error(`Cloudflare SFU 请求超时（${timeoutMs}ms）。`, { cause: error });
    }
    if (scope.signal.aborted) {
      throw createAbortError("Cloudflare SFU 请求已取消。", scope.signal.reason);
    }
    throw error;
  } finally {
    scope.dispose();
  }
}

export async function createCallsSession(
  peerConnection: RTCPeerConnection,
  control: AsyncControl = {},
): Promise<CallsSession> {
  throwIfAborted(control.signal);
  const response = await callsFetch("/sessions/new", { method: "POST" }, control);
  if (!response.sessionId) throw new Error("Cloudflare SFU 没有返回 sessionId。");
  return { id: response.sessionId, peerConnection };
}

export async function establishDataChannelTransport(
  session: CallsSession,
  control: AsyncControl = {},
) {
  throwIfAborted(control.signal);
  const bootstrapChannel = session.peerConnection.createDataChannel("server-events", {
    negotiated: false,
  });
  bootstrapChannel.addEventListener("message", () => undefined);

  const offer = await session.peerConnection.createOffer();
  throwIfAborted(control.signal);
  await session.peerConnection.setLocalDescription(offer);
  throwIfAborted(control.signal);

  const localDescription = session.peerConnection.localDescription ?? offer;
  if (!localDescription.sdp) {
    throw new Error("浏览器没有生成 SFU DataChannel transport SDP。");
  }

  const response = await callsFetch(
    `/sessions/${encodeURIComponent(session.id)}/datachannels/establish`,
    {
      method: "POST",
      body: JSON.stringify({
        dataChannel: {
          location: "remote",
          dataChannelName: "server-events",
        },
        sessionDescription: {
          type: localDescription.type,
          sdp: localDescription.sdp,
        },
      }),
    },
    control,
  );

  if (!response.sessionDescription?.sdp) {
    throw new Error("Cloudflare SFU 没有返回 DataChannel transport SDP。");
  }

  throwIfAborted(control.signal);
  await session.peerConnection.setRemoteDescription(response.sessionDescription);
  if (!response.requiresImmediateRenegotiation) return;

  const answer = await session.peerConnection.createAnswer();
  throwIfAborted(control.signal);
  await session.peerConnection.setLocalDescription(answer);
  const localAnswer = session.peerConnection.localDescription ?? answer;
  if (!localAnswer.sdp) throw new Error("浏览器没有生成 SFU 重新协商 SDP。");

  await callsFetch(
    `/sessions/${encodeURIComponent(session.id)}/renegotiate`,
    {
      method: "PUT",
      body: JSON.stringify({
        sessionDescription: {
          type: localAnswer.type,
          sdp: localAnswer.sdp,
        },
      }),
    },
    control,
  );
}

export async function createPublisherChannel(
  session: CallsSession,
  dataChannelName: string,
  control: AsyncControl = {},
) {
  validateChannelName(dataChannelName);
  throwIfAborted(control.signal);
  const response = await callsFetch(
    `/sessions/${encodeURIComponent(session.id)}/datachannels/new`,
    {
      method: "POST",
      body: JSON.stringify({
        dataChannels: [
          {
            location: "local",
            dataChannelName,
          },
        ],
      }),
    },
    control,
  );
  throwIfAborted(control.signal);
  return session.peerConnection.createDataChannel(dataChannelName, {
    negotiated: true,
    id: getDataChannelId(response),
  });
}

export async function createSubscriberChannel(
  session: CallsSession,
  publisherSessionId: string,
  dataChannelName: string,
  control: AsyncControl = {},
) {
  if (!publisherSessionId.trim()) throw new Error("SFU 发布 sessionId 不能为空。");
  validateChannelName(dataChannelName);
  throwIfAborted(control.signal);
  const response = await callsFetch(
    `/sessions/${encodeURIComponent(session.id)}/datachannels/new`,
    {
      method: "POST",
      body: JSON.stringify({
        dataChannels: [
          {
            location: "remote",
            sessionId: publisherSessionId,
            dataChannelName,
            waitForAck: true,
          },
        ],
      }),
    },
    control,
  );
  throwIfAborted(control.signal);
  return session.peerConnection.createDataChannel(`${dataChannelName}-subscribed`, {
    negotiated: true,
    id: getDataChannelId(response),
  });
}

function getDataChannelId(response: CallsApiResponse) {
  const dataChannels = response.dataChannels ?? response.datachannels ?? [];
  const id = dataChannels[0]?.id ?? response.dataChannel?.id;
  if (!Number.isInteger(id) || id! < 0 || id! > 65_534) {
    const error = dataChannels[0]?.errorDescription || dataChannels[0]?.errorCode;
    throw new Error(error || "Cloudflare SFU 没有返回有效的 DataChannel id。");
  }
  return id!;
}

function validateChannelName(value: string) {
  if (!value.trim() || value.length > 128) {
    throw new Error("SFU DataChannel 名称必须为 1 到 128 个字符。");
  }
}

function normalizeCallsPath(path: string) {
  if (!path.startsWith("/") || path.includes("..")) {
    throw new Error("SFU API 路径无效。");
  }
  return path;
}

function normalizeTimeout(value: number | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error("SFU 超时时间必须大于 0。");
  return Math.floor(value);
}

function createAbortScope(parentSignal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort(parentSignal?.reason);

  if (parentSignal?.aborted) controller.abort(parentSignal.reason);
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort(createAbortError("SFU 请求超时。"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose() {
      globalThis.clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

function createAbortError(message: string, cause?: unknown) {
  const error = new DOMException(message, "AbortError");
  if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause });
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw createAbortError("Cloudflare SFU 操作已取消。", signal.reason);
}
