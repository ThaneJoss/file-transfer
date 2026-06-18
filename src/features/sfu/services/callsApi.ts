export type SfuCredentials = {
  appId: string;
  appToken: string;
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

export const callsApiOrigin = "https://rtc.live.cloudflare.com/v1";

export function validateSfuCredentials({ appId, appToken }: SfuCredentials) {
  if (!appId.trim() || !appToken.trim()) {
    throw new Error("请填写 Cloudflare Realtime App ID 和 App Token。");
  }
}

export async function callsFetch(credentials: SfuCredentials, path: string, init: RequestInit = {}) {
  validateSfuCredentials(credentials);
  const response = await fetch(`${callsApiOrigin}/apps/${encodeURIComponent(credentials.appId.trim())}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${credentials.appToken.trim()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const data = (await response.json().catch(() => ({}))) as CallsApiResponse;
  const message = data.errorDescription || data.errorCode;
  if (!response.ok || data.errorCode) {
    throw new Error(message || `Cloudflare Realtime API 请求失败：HTTP ${response.status}`);
  }
  return data;
}

export async function createCallsSession(credentials: SfuCredentials, peerConnection: RTCPeerConnection): Promise<CallsSession> {
  const response = await callsFetch(credentials, "/sessions/new", { method: "POST" });
  if (!response.sessionId) throw new Error("Cloudflare 没有返回 sessionId。");
  return { id: response.sessionId, peerConnection };
}

export async function establishDataChannelTransport(credentials: SfuCredentials, session: CallsSession) {
  const bootstrapChannel = session.peerConnection.createDataChannel("server-events", { negotiated: false });
  bootstrapChannel.addEventListener("message", () => undefined);

  const offer = await session.peerConnection.createOffer();
  await session.peerConnection.setLocalDescription(offer);

  const response = await callsFetch(credentials, `/sessions/${session.id}/datachannels/establish`, {
    method: "POST",
    body: JSON.stringify({
      dataChannel: {
        location: "remote",
        dataChannelName: "server-events",
      },
      sessionDescription: {
        type: "offer",
        sdp: offer.sdp,
      },
    }),
  });

  if (!response.sessionDescription) {
    throw new Error("Cloudflare 没有返回 datachannel transport 的 SDP。");
  }

  if (response.requiresImmediateRenegotiation) {
    await session.peerConnection.setRemoteDescription(response.sessionDescription);
    const answer = await session.peerConnection.createAnswer();
    await session.peerConnection.setLocalDescription(answer);
    await callsFetch(credentials, `/sessions/${session.id}/renegotiate`, {
      method: "PUT",
      body: JSON.stringify({
        sessionDescription: {
          type: "answer",
          sdp: answer.sdp,
        },
      }),
    });
  } else {
    await session.peerConnection.setRemoteDescription(response.sessionDescription);
  }
}

function getDataChannelId(response: CallsApiResponse) {
  const dataChannels = response.dataChannels ?? response.datachannels ?? [];
  const id = dataChannels[0]?.id ?? response.dataChannel?.id;
  if (typeof id !== "number") {
    const error = dataChannels[0]?.errorDescription || dataChannels[0]?.errorCode;
    throw new Error(error || "Cloudflare 没有返回 DataChannel id。");
  }
  return id;
}

export async function createPublisherChannel(credentials: SfuCredentials, session: CallsSession, dataChannelName: string) {
  const response = await callsFetch(credentials, `/sessions/${session.id}/datachannels/new`, {
    method: "POST",
    body: JSON.stringify({
      dataChannels: [
        {
          location: "local",
          dataChannelName,
        },
      ],
    }),
  });
  return session.peerConnection.createDataChannel(dataChannelName, {
    negotiated: true,
    id: getDataChannelId(response),
  });
}

export async function createSubscriberChannel(
  credentials: SfuCredentials,
  session: CallsSession,
  publisherSessionId: string,
  dataChannelName: string,
) {
  const response = await callsFetch(credentials, `/sessions/${session.id}/datachannels/new`, {
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
  });
  return session.peerConnection.createDataChannel(`${dataChannelName}-subscribed`, {
    negotiated: true,
    id: getDataChannelId(response),
  });
}
