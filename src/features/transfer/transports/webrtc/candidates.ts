import type { WebRtcRoute, WebRtcSignal, WebRtcSignalRole } from "./types";

export type IceCandidateType = "host" | "srflx" | "relay";

export type IceCandidateSummary = Record<IceCandidateType, number> & {
  total: number;
};

const routeCandidateType: Record<WebRtcRoute, IceCandidateType> = {
  direct: "host",
  stun: "srflx",
  turn: "relay",
};

export function candidateTypeForRoute(route: WebRtcRoute) {
  return routeCandidateType[route];
}

export function getIceCandidateType(candidate: string): IceCandidateType | null {
  const match = candidate.match(/(?:^|\s)typ\s+(host|srflx|relay)(?:\s|$)/);
  return (match?.[1] as IceCandidateType | undefined) ?? null;
}

export function filterIceCandidates(candidates: RTCIceCandidateInit[], allowedTypes: IceCandidateType[]) {
  return candidates.filter((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const type = candidate.candidate ? getIceCandidateType(candidate.candidate) : null;
    return type !== null && allowedTypes.includes(type);
  });
}

export function filterSessionDescriptionCandidates(
  description: RTCSessionDescriptionInit,
  allowedTypes: IceCandidateType[],
): RTCSessionDescriptionInit {
  // RTCSessionDescription exposes `type` and `sdp` through prototype getters
  // in real browsers, so spreading it produces an empty object. Copy the two
  // protocol fields explicitly before serializing the signal.
  if (!description.sdp) return { type: description.type, sdp: description.sdp };

  const sdp = description.sdp
    .split(/\r?\n/)
    .filter((line) => {
      if (line === "a=end-of-candidates") return false;
      if (!line.startsWith("a=candidate:")) return true;
      const type = getIceCandidateType(line.slice(2));
      return type !== null && allowedTypes.includes(type);
    })
    .join("\r\n");

  return { type: description.type, sdp };
}

export function summarizeIceCandidates(
  description: RTCSessionDescriptionInit | null,
  candidates: RTCIceCandidateInit[] = [],
): IceCandidateSummary {
  const unique = new Set<string>();
  for (const line of description?.sdp?.match(/^a=candidate:.*$/gm) ?? []) {
    unique.add(line.slice(2));
  }
  for (const candidate of candidates) {
    if (candidate.candidate) unique.add(candidate.candidate);
  }

  const summary: IceCandidateSummary = { host: 0, srflx: 0, relay: 0, total: 0 };
  for (const candidate of unique) {
    const type = getIceCandidateType(candidate);
    if (!type) continue;
    summary[type] += 1;
    summary.total += 1;
  }
  return summary;
}

export function assertRouteCandidates(
  route: WebRtcRoute,
  description: RTCSessionDescriptionInit | null,
  candidates: RTCIceCandidateInit[],
  side: "本端" | "对端",
) {
  const required = candidateTypeForRoute(route);
  const summary = summarizeIceCandidates(description, candidates);
  if (summary[required] > 0) return;

  const routeName = route === "direct" ? "Direct" : route.toUpperCase();
  const noFallback = route === "stun" ? "，不会回退到 host 直连" : "";
  throw new Error(`${routeName} ${side}没有收集到 ${required} candidate，该路径不可用${noFallback}。`);
}

export function createWebRtcSignal(
  route: WebRtcRoute,
  role: WebRtcSignalRole,
  description: RTCSessionDescriptionInit,
  candidates: RTCIceCandidateInit[],
): WebRtcSignal {
  const allowedType = candidateTypeForRoute(route);
  const filteredDescription = filterSessionDescriptionCandidates(description, [allowedType]);
  const filteredCandidates = filterIceCandidates(candidates, [allowedType]);
  assertRouteCandidates(route, filteredDescription, filteredCandidates, "本端");

  return {
    kind: "file-transfer-webrtc-signal",
    version: 1,
    route,
    role,
    description: filteredDescription,
    candidates: filteredCandidates,
    createdAt: Date.now(),
  };
}

export function sanitizeRemoteSignal(
  signal: WebRtcSignal,
  expectedRoute: WebRtcRoute,
  expectedRole: WebRtcSignalRole,
): WebRtcSignal {
  if (
    signal.kind !== "file-transfer-webrtc-signal" ||
    signal.version !== 1 ||
    signal.route !== expectedRoute ||
    signal.role !== expectedRole ||
    !signal.description ||
    signal.description.type !== expectedRole ||
    typeof signal.description.sdp !== "string" ||
    !Array.isArray(signal.candidates)
  ) {
    throw new Error(`${expectedRoute.toUpperCase()} WebRTC 信令格式不正确。`);
  }

  const allowedType = candidateTypeForRoute(expectedRoute);
  const sanitized: WebRtcSignal = {
    ...signal,
    description: filterSessionDescriptionCandidates(signal.description, [allowedType]),
    candidates: filterIceCandidates(signal.candidates, [allowedType]),
  };
  assertRouteCandidates(expectedRoute, sanitized.description, sanitized.candidates, "对端");
  return sanitized;
}
