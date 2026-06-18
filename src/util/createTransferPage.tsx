import {
  ArrowLeft,
  Check,
  Circle,
  Copy,
  Database,
  Download,
  FileText,
  Gauge,
  HardDrive,
  Link2,
  RefreshCw,
  Send,
  Server,
  UploadCloud,
  Wifi,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";

import { PrimaryButton, SecondaryButton, StatusMessage, TextArea, TextInput } from "../component/TransferControls";
import { waitForBuffer, waitForDataChannelOpen } from "../features/transfer/services/dataChannel";
import { decodeConnectionPayload, encodeConnectionPayload } from "../features/transfer/protocol/connectionCode";
import { generateCloudflareTurnIceServers } from "../features/turn/services/cloudflareTurn";
import {
  ActionPanel,
  ConnectionDetails,
  FilePickerPanel,
  FilesPanel,
  MainPanelGrid,
  ReceivedFilesPanel,
  RoleOption,
  StatusPanel,
  StatusPanelHeader,
  TransferPageGrid,
  TransferSteps,
  UploadPanel,
} from "../layout/TransferLayout";
import type { MetricItem, TransferStepItem } from "../layout/TransferLayout";
import { copyText } from "../lib/browser/clipboard";
import { saveBlob } from "../lib/browser/download";
import { formatBytes, formatPercent } from "../lib/files/format";

type SignalPayload = {
  kind: SignalKind;
  role: "offer" | "answer";
  description: RTCSessionDescriptionInit;
  candidates?: RTCIceCandidateInit[];
  createdAt: number;
};

type SignalKind = "direct-webrtc-signal" | "stun-webrtc-signal" | "turn-webrtc-signal";

type TransferMeta = {
  kind: "meta";
  name: string;
  size: number;
  type: string;
  lastModified: number;
};

type TransferDone = {
  kind: "done";
};

type ReceivedFile = {
  id: string;
  name: string;
  size: number;
  type: string;
  url: string;
  receivedAt: string;
};

type TransferMode = "send" | "receive" | null;
type SenderHandshakeStage = "offer" | "answer";
type TransferVariant = "direct" | "stun" | "turn";

type CandidateSummary = {
  host: number;
  srflx: number;
  relay: number;
  total: number;
};

type CandidateType = "host" | "srflx" | "relay";
type TurnTransport = "udp" | "tcp";

type TurnTransportSummary = Record<TurnTransport, number> & {
  total: number;
};

type SelectedCandidatePair = {
  local: string;
  remote: string;
  state: string;
  rtt: string;
};

type TransferVariantConfig = {
  connectionType: string;
  description: string;
  signalKind: SignalKind;
  rtcConfig: RTCConfiguration;
  initialSenderStatus: string;
  initialReceiverStatus: string;
  offerGatheringStatus: string;
  answerGatheringStatus: string;
  offerCandidateLabel: string;
  answerCandidateLabel: string;
  serverLabel?: string;
  requiredCandidateTypes?: CandidateType[];
  signalCandidateTypes: CandidateType[];
};

const transferVariantConfig: Record<TransferVariant, TransferVariantConfig> = {
  direct: {
    connectionType: "Direct DataChannel",
    description: "手动复制 Offer / Answer，文件走 DataChannel 点对点传输。",
    signalKind: "direct-webrtc-signal",
    rtcConfig: { iceServers: [] },
    initialSenderStatus: "选择文件后生成 Offer。",
    initialReceiverStatus: "等待发送方 Offer。",
    offerGatheringStatus: "正在创建 WebRTC Offer，并收集本地 host 候选地址...",
    answerGatheringStatus: "正在读取 Offer，并收集接收方 host 候选地址...",
    offerCandidateLabel: "Offer",
    answerCandidateLabel: "Answer",
    signalCandidateTypes: ["host", "srflx", "relay"],
  },
  stun: {
    connectionType: "STUN DataChannel",
    description: "通过 Cloudflare STUN 发现公网映射，再用 DataChannel 点对点传输文件。",
    signalKind: "stun-webrtc-signal",
    rtcConfig: { iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] },
    initialSenderStatus: "选择文件后通过 Cloudflare STUN 生成 Offer。",
    initialReceiverStatus: "等待发送方 STUN Offer。",
    offerGatheringStatus: "正在创建 WebRTC Offer，并通过 Cloudflare STUN 收集候选地址...",
    answerGatheringStatus: "正在读取 STUN Offer，并通过 Cloudflare STUN 收集接收方候选地址...",
    offerCandidateLabel: "STUN Offer",
    answerCandidateLabel: "STUN Answer",
    serverLabel: "stun.cloudflare.com:3478",
    requiredCandidateTypes: ["srflx"],
    signalCandidateTypes: ["srflx", "relay"],
  },
  turn: {
    connectionType: "TURN Relay DataChannel",
    description: "TURN relay 中继 DataChannel，适合无法直连的网络。",
    signalKind: "turn-webrtc-signal",
    rtcConfig: { iceServers: [], iceTransportPolicy: "relay" },
    initialSenderStatus: "选择文件后通过 TURN 生成 Offer。",
    initialReceiverStatus: "等待发送方 TURN Offer。",
    offerGatheringStatus: "正在创建 WebRTC Offer，并通过 TURN 收集 relay 候选地址...",
    answerGatheringStatus: "正在读取 TURN Offer，并通过 TURN 收集接收方 relay 候选地址...",
    offerCandidateLabel: "TURN Offer",
    answerCandidateLabel: "TURN Answer",
    serverLabel: "等待生成 Cloudflare TURN iceServers",
    requiredCandidateTypes: ["relay"],
    signalCandidateTypes: ["relay"],
  },
};

const emptyCandidateSummary: CandidateSummary = { host: 0, srflx: 0, relay: 0, total: 0 };
const emptyTurnTransportSummary: TurnTransportSummary = { udp: 0, tcp: 0, total: 0 };
const emptySelectedPair: SelectedCandidatePair = {
  local: "未连接",
  remote: "未连接",
  state: "unknown",
  rtt: "-",
};
const chunkSize = 256 * 1024;
const highWaterMark = 16 * 1024 * 1024;
const lowWaterMark = 4 * 1024 * 1024;
const progressUpdateIntervalMs = 100;
const iceGatheringTimeoutMs = 30000;
const turnIceGatheringTimeoutMs = 90000;
const turnProbeGatheringTimeoutMs = 15000;
const channelOpenTimeoutMs = 18000;
const turnChannelOpenTimeoutMs = 90000;
const defaultTurnKeyId = "";
const defaultTurnApiToken = "";
const turnTransports: TurnTransport[] = ["udp", "tcp"];

async function encodeSignal(payload: SignalPayload) {
  return encodeConnectionPayload(payload);
}

async function decodeSignal(value: string): Promise<SignalPayload> {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("请先粘贴连接文本。");
  }

  const json = await decodeConnectionPayload(trimmed, "当前浏览器不能解压 D1 连接文本，请换用最新版 Chrome、Edge 或 Safari。");
  return parseSignal(json);
}

function parseSignal(json: string): SignalPayload {
  const payload = JSON.parse(json) as SignalPayload;
  if (
    (payload.kind !== "direct-webrtc-signal" &&
      payload.kind !== "stun-webrtc-signal" &&
      payload.kind !== "turn-webrtc-signal") ||
    !payload.description?.type ||
    !payload.description.sdp
  ) {
    throw new Error("连接文本格式不正确。");
  }
  return payload;
}

function getCandidateType(candidate: string): CandidateType | null {
  if (/\styp host(\s|$)/.test(candidate)) return "host";
  if (/\styp srflx(\s|$)/.test(candidate)) return "srflx";
  if (/\styp relay(\s|$)/.test(candidate)) return "relay";
  return null;
}

function isAllowedCandidate(candidate: string, allowedTypes: CandidateType[]) {
  const type = getCandidateType(candidate);
  return Boolean(type && allowedTypes.includes(type));
}

function isCandidateType(candidate: string, types?: CandidateType[]) {
  if (!types?.length) return true;
  const type = getCandidateType(candidate);
  return Boolean(type && types.includes(type));
}

function filterSdpCandidates(sdp: string, allowedTypes: CandidateType[]) {
  return sdp
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.startsWith("a=candidate:")) return true;
      return isAllowedCandidate(line.replace(/^a=/, ""), allowedTypes);
    })
    .join("\r\n");
}

function ensureEndOfCandidates(sdp: string) {
  if (/^a=end-of-candidates$/m.test(sdp)) return sdp;
  return `${sdp.replace(/\r?\n*$/, "")}\r\na=end-of-candidates\r\n`;
}

function createSignalPayloadParts(
  description: RTCSessionDescriptionInit,
  candidates: RTCIceCandidateInit[],
  allowedTypes: CandidateType[],
  includeEndOfCandidates = true,
) {
  const filteredDescription = {
    ...description,
    sdp: description.sdp
      ? includeEndOfCandidates
        ? ensureEndOfCandidates(filterSdpCandidates(description.sdp, allowedTypes))
        : filterSdpCandidates(description.sdp, allowedTypes)
      : description.sdp,
  };
  const filteredCandidates = candidates.filter((candidate) =>
    candidate.candidate ? isAllowedCandidate(candidate.candidate, allowedTypes) : false,
  );
  return {
    description: filteredDescription,
    candidates: filteredCandidates,
    summary: summarizeCandidates(filteredDescription, filteredCandidates),
  };
}

function summarizeCandidates(
  description: RTCSessionDescriptionInit | null,
  candidates: RTCIceCandidateInit[] = [],
): CandidateSummary {
  const sdp = description?.sdp ?? "";
  const summary = { host: 0, srflx: 0, relay: 0, total: 0 };
  const candidateLines = [
    ...(sdp.match(/^a=candidate:.*$/gm) ?? []).map((candidate) =>
      candidate.replace(/^a=/, ""),
    ),
    ...candidates
      .map((candidate) => candidate.candidate)
      .filter((candidate): candidate is string => Boolean(candidate)),
  ];
  const uniqueCandidates = new Set(candidateLines);

  for (const candidate of uniqueCandidates) {
    summary.total += 1;
    const type = getCandidateType(candidate);
    if (type === "host") summary.host += 1;
    if (type === "srflx") summary.srflx += 1;
    if (type === "relay") summary.relay += 1;
  }
  return summary;
}

function formatCandidateSummary(
  description: RTCSessionDescriptionInit | null,
  candidates: RTCIceCandidateInit[] = [],
) {
  const summary = summarizeCandidates(description, candidates);
  if (summary.total === 0) return "未收集到候选地址";
  return `${summary.total} 个候选地址，host ${summary.host}，srflx ${summary.srflx}，relay ${summary.relay}`;
}

function mergeCandidateSummaries(...summaries: CandidateSummary[]) {
  return summaries.reduce<CandidateSummary>(
    (merged, summary) => ({
      host: merged.host + summary.host,
      srflx: merged.srflx + summary.srflx,
      relay: merged.relay + summary.relay,
      total: merged.total + summary.total,
    }),
    { ...emptyCandidateSummary },
  );
}

function formatStoredCandidateSummary(summary: CandidateSummary) {
  if (summary.total === 0) return "未收集";
  return `${summary.total} 个，host ${summary.host}，srflx ${summary.srflx}，relay ${summary.relay}`;
}

function hasRequiredCandidate(summary: CandidateSummary, requiredTypes?: CandidateType[]) {
  if (!requiredTypes?.length) return summary.total > 0;
  return requiredTypes.some((type) => summary[type] > 0);
}

function formatRequiredCandidateTypes(requiredTypes?: CandidateType[]) {
  return requiredTypes?.join("/") ?? "ICE";
}

function formatIceServerUrls(iceServers: RTCIceServer[]) {
  const urls = iceServers.flatMap((server) => {
    if (Array.isArray(server.urls)) return server.urls;
    return server.urls ? [server.urls] : [];
  });
  if (urls.length === 0) return "未配置";
  return urls.join(", ");
}

function getTurnUrlTransport(url: string): TurnTransport | null {
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.startsWith("turns:")) return "tcp";
  if (!lowerUrl.startsWith("turn:")) return null;
  if (lowerUrl.includes("transport=tcp")) return "tcp";
  if (lowerUrl.includes("transport=udp")) return "udp";
  return "udp";
}

function filterIceServersByTurnTransport(iceServers: RTCIceServer[], transport: TurnTransport) {
  return iceServers.flatMap<RTCIceServer>((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : server.urls ? [server.urls] : [];
    const filteredUrls = urls.filter((url) => getTurnUrlTransport(url) === transport);
    if (filteredUrls.length === 0) return [];

    return [
      {
        urls: filteredUrls.length === 1 ? filteredUrls[0] : filteredUrls,
        username: server.username,
        credential: server.credential,
      },
    ];
  });
}

function mergeTurnTransportSummary(summary: TurnTransportSummary, transport: TurnTransport, relayCount: number) {
  const next = { ...summary, [transport]: relayCount };
  next.total = next.udp + next.tcp;
  return next;
}

function formatRelayServerStatus(
  protocolLabel: string,
  summary: CandidateSummary,
  gatheringStates: string[],
  requiredTypes?: CandidateType[],
) {
  const required = formatRequiredCandidateTypes(requiredTypes);
  if (hasRequiredCandidate(summary, requiredTypes)) return `已收集 ${required} 候选`;
  if (gatheringStates.some((state) => state === "gathering")) return `正在通过 ${protocolLabel} 收集`;
  if (summary.total > 0) return `已收集候选，但未得到 ${required}`;
  return `等待 ${protocolLabel} 收集`;
}

function formatSelectedPair(pair: SelectedCandidatePair) {
  if (pair.local === "未连接" && pair.remote === "未连接") return "未连接";
  return `${pair.local} -> ${pair.remote}`;
}

function formatStepError(variant: TransferVariant, step: string, error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  return variant === "direct" ? message : `${step}：${message}`;
}

function assertHasCandidates(
  description: RTCSessionDescriptionInit | null,
  candidates: RTCIceCandidateInit[],
  label: string,
  requiredTypes?: CandidateType[],
) {
  const summary = summarizeCandidates(description, candidates);
  if (summary.total === 0) {
    throw new Error(`${label} 没有包含 ICE candidate，请刷新页面后重新生成。`);
  }
  if (requiredTypes?.length && !hasRequiredCandidate(summary, requiredTypes)) {
    throw new Error(`${label} 没有收集到 ${formatRequiredCandidateTypes(requiredTypes)} 候选地址，请确认网络可以访问服务器后重新生成。`);
  }
}

function assertUsableRemoteCandidates(payload: SignalPayload, label: string, requiredTypes?: CandidateType[]) {
  const summary = summarizeCandidates(payload.description, payload.candidates);
  if (requiredTypes?.length && !hasRequiredCandidate(summary, requiredTypes)) {
    throw new Error(`${label} 没有可用于连接的 ${formatRequiredCandidateTypes(requiredTypes)} 候选。对方需要重新生成信令。`);
  }
}

function formatIceCandidateError(event: RTCPeerConnectionIceErrorEvent) {
  const url = event.url ? `${event.url} ` : "";
  return `${url}${event.errorCode}${event.errorText ? ` ${event.errorText}` : ""}`;
}

function collectIceCandidates(peer: RTCPeerConnection, onChange?: () => void) {
  const candidates: RTCIceCandidateInit[] = [];
  const errors: string[] = [];
  const onCandidate = (event: RTCPeerConnectionIceEvent) => {
    if (event.candidate) {
      candidates.push(event.candidate.toJSON());
      onChange?.();
    }
  };
  const onCandidateError = (event: RTCPeerConnectionIceErrorEvent) => {
    errors.push(formatIceCandidateError(event));
    onChange?.();
  };
  peer.addEventListener("icecandidate", onCandidate);
  peer.addEventListener("icecandidateerror", onCandidateError);
  return {
    candidates,
    errors,
    stop: () => {
      peer.removeEventListener("icecandidate", onCandidate);
      peer.removeEventListener("icecandidateerror", onCandidateError);
    },
  };
}

async function addPayloadCandidates(peer: RTCPeerConnection, payload: SignalPayload) {
  const candidates = payload.candidates ?? [];
  if (candidates.length === 0) return;

  const sdpCandidates = new Set(
    (payload.description.sdp?.match(/^a=candidate:.*$/gm) ?? []).map((line) =>
      line.replace(/^a=/, ""),
    ),
  );

  for (const candidate of candidates) {
    if (!candidate.candidate || sdpCandidates.has(candidate.candidate)) continue;
    await peer.addIceCandidate(candidate);
  }
  await peer.addIceCandidate();
}

function createPeerConnection(
  config: RTCConfiguration,
  onState: (peer: RTCPeerConnection) => void,
  onError: (message: string) => void,
  onIceCandidateError?: (message: string) => void,
) {
  const peer = new RTCPeerConnection(config);
  const notify = () => onState(peer);
  peer.addEventListener("connectionstatechange", notify);
  peer.addEventListener("iceconnectionstatechange", notify);
  peer.addEventListener("signalingstatechange", notify);
  peer.addEventListener("icegatheringstatechange", notify);
  peer.addEventListener("icecandidateerror", (event) => {
    const message = `ICE 候选收集失败：${formatIceCandidateError(event)}`;
    if (onIceCandidateError) onIceCandidateError(message);
    else onError(message);
  });
  return peer;
}

function formatIceGatheringTimeout(
  candidates: RTCIceCandidateInit[],
  errors: string[],
) {
  const summary = formatStoredCandidateSummary(summarizeCandidates(null, candidates));
  const errorText = errors.length > 0 ? `最近的 ICE 错误：${errors.slice(-4).join("；")}` : "没有收到浏览器返回的 ICE 错误。";
  return `ICE candidate 收集没有进入 complete。已收集：${summary}。${errorText}`;
}

function hasCandidateType(candidates: RTCIceCandidateInit[], types?: CandidateType[]) {
  if (!types?.length) return candidates.length > 0;
  return candidates.some((candidate) => candidate.candidate && isCandidateType(candidate.candidate, types));
}

function waitForIceGathering(
  peer: RTCPeerConnection,
  collection?: { candidates: RTCIceCandidateInit[]; errors: string[] },
  timeoutMs = iceGatheringTimeoutMs,
) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let finished = false;
    const done = (error?: Error) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onChange);
      if (error) reject(error);
      else resolve();
    };
    const onChange = () => {
      if (peer.iceGatheringState === "complete") done();
    };
    const timer = window.setTimeout(() => {
      done(new Error(formatIceGatheringTimeout(collection?.candidates ?? [], collection?.errors ?? [])));
    }, timeoutMs);
    peer.addEventListener("icegatheringstatechange", onChange);
  });
}

function observeIceProbe({
  config,
  requiredTypes,
  timeoutMs = iceGatheringTimeoutMs,
  onSummary,
  onReady,
  onComplete,
}: {
  config: RTCConfiguration;
  requiredTypes?: CandidateType[];
  timeoutMs?: number;
  onSummary: (summary: CandidateSummary) => void;
  onReady: (summary: CandidateSummary) => void;
  onComplete: (summary: CandidateSummary) => void;
}) {
  return new Promise<void>((resolve, reject) => {
    const peer = new RTCPeerConnection(config);
    let ready = false;
    let finished = false;
    let timeout: number | undefined;
    let ice: ReturnType<typeof collectIceCandidates>;

    const finish = (complete = false) => {
      if (finished) return;
      finished = true;
      if (timeout != null) window.clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", onGatheringChange);
      ice.stop();
      const summary = summarizeCandidates(peer.localDescription, ice.candidates);
      if (complete) onComplete(summary);
      peer.close();
    };

    const fail = (error: Error) => {
      finish(false);
      reject(error);
    };

    const publish = () => {
      const summary = summarizeCandidates(peer.localDescription, ice.candidates);
      onSummary(summary);
      if (!ready && hasRequiredCandidate(summary, requiredTypes)) {
        ready = true;
        onReady(summary);
        resolve();
      }
      return summary;
    };

    const onGatheringChange = () => {
      const summary = publish();
      if (peer.iceGatheringState === "complete") {
        if (ready) finish(true);
        else fail(new Error(`${formatStoredCandidateSummary(summary)}。${formatIceGatheringTimeout(ice.candidates, ice.errors)}`));
      }
    };

    ice = collectIceCandidates(peer, publish);
    peer.addEventListener("icegatheringstatechange", onGatheringChange);

    void (async () => {
      try {
        peer.createDataChannel("stun-probe");
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        publish();
        timeout = window.setTimeout(() => {
          if (!ready) {
            const summary = summarizeCandidates(peer.localDescription, ice.candidates);
            const errorText = formatIceGatheringTimeout(ice.candidates, ice.errors);
            fail(new Error(`${formatStoredCandidateSummary(summary)}。${errorText}`));
          }
        }, timeoutMs);
      } catch (error) {
        fail(error instanceof Error ? error : new Error("ICE probe 启动失败。"));
      }
    })();
  });
}

function getStatsValue(stats: RTCStats, key: string) {
  return (stats as unknown as Record<string, unknown>)[key];
}

function formatCandidateStats(stats: RTCStats | undefined) {
  if (!stats) return "unknown";
  const candidateType = String(getStatsValue(stats, "candidateType") ?? "unknown");
  const protocol = String(getStatsValue(stats, "protocol") ?? "");
  const relayProtocol = String(getStatsValue(stats, "relayProtocol") ?? "");
  const protocolText = relayProtocol && relayProtocol !== protocol ? `${protocol || "?"} via ${relayProtocol}` : protocol;
  const address = String(getStatsValue(stats, "address") ?? getStatsValue(stats, "ip") ?? "?");
  const port = getStatsValue(stats, "port");
  const portText = typeof port === "number" || typeof port === "string" ? `:${port}` : "";
  return `${candidateType} ${protocolText ? `${protocolText} ` : ""}${address}${portText}`;
}

async function getSelectedCandidatePair(peer: RTCPeerConnection): Promise<SelectedCandidatePair> {
  const report = await peer.getStats();
  let selectedPair: RTCStats | undefined;

  for (const stats of report.values()) {
    if (stats.type !== "transport") continue;
    const selectedPairId = getStatsValue(stats, "selectedCandidatePairId");
    if (typeof selectedPairId === "string") {
      selectedPair = report.get(selectedPairId);
      break;
    }
  }

  if (!selectedPair) {
    for (const stats of report.values()) {
      if (stats.type !== "candidate-pair") continue;
      const nominated = getStatsValue(stats, "nominated") === true;
      const state = getStatsValue(stats, "state");
      if (nominated && state === "succeeded") {
        selectedPair = stats;
        break;
      }
    }
  }

  if (!selectedPair) return emptySelectedPair;

  const localCandidateId = getStatsValue(selectedPair, "localCandidateId");
  const remoteCandidateId = getStatsValue(selectedPair, "remoteCandidateId");
  const localStats = typeof localCandidateId === "string" ? report.get(localCandidateId) : undefined;
  const remoteStats = typeof remoteCandidateId === "string" ? report.get(remoteCandidateId) : undefined;
  const rtt = getStatsValue(selectedPair, "currentRoundTripTime");
  const rttText = typeof rtt === "number" ? `${Math.round(rtt * 1000)} ms` : "-";

  return {
    local: formatCandidateStats(localStats),
    remote: formatCandidateStats(remoteStats),
    state: String(getStatsValue(selectedPair, "state") ?? "unknown"),
    rtt: rttText,
  };
}

export function createTransferPage(variant: TransferVariant) {
  return function TransferPage() {
  const config = transferVariantConfig[variant];
  const protocolLabel = variant === "direct" ? "Direct" : variant.toUpperCase();
  const signalPrefix = variant === "direct" ? "" : `${protocolLabel} `;
  const usesIceServer = variant !== "direct";
  const senderPeerRef = useRef<RTCPeerConnection | null>(null);
  const receiverPeerRef = useRef<RTCPeerConnection | null>(null);
  const senderChannelRef = useRef<RTCDataChannel | null>(null);
  const receiverChannelRef = useRef<RTCDataChannel | null>(null);
  const receiveChunksRef = useRef<ArrayBuffer[]>([]);
  const receiveMetaRef = useRef<TransferMeta | null>(null);
  const receivedBytesRef = useRef(0);
  const receiveProgressUpdateAtRef = useRef(0);
  const receivedFilesRef = useRef<ReceivedFile[]>([]);
  const sendInFlightRef = useRef(false);
  const stunProbeInFlightRef = useRef(false);
  const senderFileInputRef = useRef<HTMLInputElement | null>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [senderOffer, setSenderOffer] = useState("");
  const [senderAnswerInput, setSenderAnswerInput] = useState("");
  const [senderStatus, setSenderStatus] = useState(config.initialSenderStatus);
  const [senderError, setSenderError] = useState("");
  const [senderPeerState, setSenderPeerState] = useState("new");
  const [senderIceState, setSenderIceState] = useState("new");
  const [senderIceGatheringState, setSenderIceGatheringState] = useState("new");
  const [senderCandidateSummary, setSenderCandidateSummary] = useState<CandidateSummary>(emptyCandidateSummary);
  const [senderChannelState, setSenderChannelState] = useState("closed");
  const [senderProgress, setSenderProgress] = useState(0);
  const [sentBytes, setSentBytes] = useState(0);
  const [isSending, setIsSending] = useState(false);

  const [receiverOfferInput, setReceiverOfferInput] = useState("");
  const [receiverAnswer, setReceiverAnswer] = useState("");
  const [receiverStatus, setReceiverStatus] = useState(config.initialReceiverStatus);
  const [receiverError, setReceiverError] = useState("");
  const [receiverPeerState, setReceiverPeerState] = useState("new");
  const [receiverIceState, setReceiverIceState] = useState("new");
  const [receiverIceGatheringState, setReceiverIceGatheringState] = useState("new");
  const [receiverCandidateSummary, setReceiverCandidateSummary] = useState<CandidateSummary>(emptyCandidateSummary);
  const [receiverChannelState, setReceiverChannelState] = useState("closed");
  const [receiverProgress, setReceiverProgress] = useState(0);
  const [receivedBytes, setReceivedBytes] = useState(0);
  const [incomingMeta, setIncomingMeta] = useState<TransferMeta | null>(null);
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const [transferMode, setTransferMode] = useState<TransferMode>(null);
  const [statusPanelView, setStatusPanelView] = useState<"status" | "details">("status");
  const [senderHandshakeStage, setSenderHandshakeStage] = useState<SenderHandshakeStage>("offer");
  const [isStunProbing, setIsStunProbing] = useState(false);
  const [stunProbeStatus, setStunProbeStatus] = useState("等待 probe");
  const [stunProbeError, setStunProbeError] = useState("");
  const [stunProbeSummary, setStunProbeSummary] = useState<CandidateSummary>(emptyCandidateSummary);
  const [senderSelectedPair, setSenderSelectedPair] = useState<SelectedCandidatePair>(emptySelectedPair);
  const [receiverSelectedPair, setReceiverSelectedPair] = useState<SelectedCandidatePair>(emptySelectedPair);
  const [turnKeyId, setTurnKeyId] = useState(defaultTurnKeyId);
  const [turnApiToken, setTurnApiToken] = useState(defaultTurnApiToken);
  const [turnTtl, setTurnTtl] = useState("3600");
  const [turnIceServers, setTurnIceServers] = useState<RTCIceServer[]>([]);
  const [turnTransport, setTurnTransport] = useState<TurnTransport>("udp");
  const [turnProbeTransportSummary, setTurnProbeTransportSummary] = useState<TurnTransportSummary>(emptyTurnTransportSummary);
  const [turnCredentialStatus, setTurnCredentialStatus] = useState("等待生成临时 TURN iceServers");
  const [turnCredentialError, setTurnCredentialError] = useState("");
  const [isGeneratingTurnCredentials, setIsGeneratingTurnCredentials] = useState(false);

  const activeTurnIceServers = useMemo(
    () => (variant === "turn" ? filterIceServersByTurnTransport(turnIceServers, turnTransport) : []),
    [turnIceServers, turnTransport, variant],
  );
  const activeRtcConfig = useMemo<RTCConfiguration>(
    () =>
      variant === "turn"
        ? { iceServers: activeTurnIceServers, iceTransportPolicy: "relay" }
        : config.rtcConfig,
    [activeTurnIceServers, config.rtcConfig, variant],
  );
  const serverLabel = variant === "turn" ? formatIceServerUrls(activeTurnIceServers) : config.serverLabel;
  const hasTurnIceServers = variant !== "turn" || turnIceServers.length > 0;
  const turnReady =
    variant !== "turn" ||
    (activeTurnIceServers.length > 0 && turnProbeTransportSummary[turnTransport] > 0);

  useEffect(() => {
    return () => {
      senderPeerRef.current?.close();
      receiverPeerRef.current?.close();
      receivedFilesRef.current.forEach((file) => URL.revokeObjectURL(file.url));
    };
  }, []);

  useEffect(() => {
    receivedFilesRef.current = receivedFiles;
  }, [receivedFiles]);

  useEffect(() => {
    if (variant === "stun") {
      void probeIceServer();
    }
  }, []);

  const totalBytes = selectedFile?.size ?? incomingMeta?.size ?? 0;
  const progress = Math.max(senderProgress, receiverProgress);
  const combinedCandidateSummary = mergeCandidateSummaries(senderCandidateSummary, receiverCandidateSummary);
  const combinedServerSummary = mergeCandidateSummaries(stunProbeSummary, combinedCandidateSummary);
  const serverStatus = formatRelayServerStatus(protocolLabel, combinedServerSummary, [
    senderIceGatheringState,
    receiverIceGatheringState,
  ], config.requiredCandidateTypes);

  const transferSteps: TransferStepItem[] =
    usesIceServer
      ? [
          {
            label: protocolLabel,
            meta: hasRequiredCandidate(combinedServerSummary, config.requiredCandidateTypes)
              ? `已收集 ${formatRequiredCandidateTypes(config.requiredCandidateTypes)}`
              : isStunProbing
                ? "probe 中"
                : "等待收集",
            icon: Server,
            active: hasRequiredCandidate(combinedServerSummary, config.requiredCandidateTypes),
          },
          {
            label: "信令",
            meta: senderAnswerInput || receiverAnswer ? "已交换" : senderOffer || receiverOfferInput ? "交换中" : "等待生成",
            icon: Link2,
            active: Boolean(senderOffer || receiverOfferInput),
          },
          {
            label: "通道",
            meta: senderChannelState === "open" || receiverChannelState === "open" ? "已打开" : "未打开",
            icon: Wifi,
            active: senderChannelState === "open" || receiverChannelState === "open",
          },
          {
            label: "文件",
            meta: progress >= 100 ? "已完成" : progress > 0 ? "传输中" : "等待传输",
            icon: Check,
            active: progress >= 100,
          },
        ]
      : [
          {
            label: "Offer",
            meta: senderOffer || receiverOfferInput ? "已生成" : "等待生成",
            icon: FileText,
            active: Boolean(senderOffer || receiverOfferInput),
          },
          {
            label: "Answer",
            meta: senderAnswerInput || receiverAnswer ? "已交换" : "等待交换",
            icon: Link2,
            active: Boolean(senderAnswerInput || receiverAnswer),
          },
          {
            label: "DataChannel",
            meta: senderChannelState === "open" || receiverChannelState === "open" ? "已打开" : "未打开",
            icon: Wifi,
            active: senderChannelState === "open" || receiverChannelState === "open",
          },
          {
            label: "文件",
            meta: progress >= 100 ? "已完成" : progress > 0 ? "传输中" : "等待传输",
            icon: Check,
            active: progress >= 100,
          },
        ];

  const details: MetricItem[] = [
    { label: "连接类型", value: config.connectionType, icon: Link2 },
    ...(usesIceServer
      ? [
          {
            label: `${protocolLabel}状态`,
            value: serverStatus,
            icon: Server,
            active: hasRequiredCandidate(combinedServerSummary, config.requiredCandidateTypes),
          },
          { label: `${protocolLabel}服务器`, value: serverLabel ?? "未配置", icon: Server },
          ...(variant === "turn"
            ? [{ label: "TURN模式", value: turnTransport.toUpperCase(), icon: Gauge }]
            : []),
          {
            label: "独立Probe",
            value: stunProbeError || `${stunProbeStatus}，${formatStoredCandidateSummary(stunProbeSummary)}`,
            icon: Gauge,
            active: hasRequiredCandidate(stunProbeSummary, config.requiredCandidateTypes),
          },
        ]
      : []),
    {
      label: "发送端状态",
      value: `${senderPeerState} / ${senderIceState}`,
      icon: Circle,
      active: senderPeerState === "connected",
    },
    {
      label: "接收端状态",
      value: `${receiverPeerState} / ${receiverIceState}`,
      icon: Circle,
      active: receiverPeerState === "connected",
    },
    { label: "发送通道", value: senderChannelState, icon: Wifi },
    { label: "接收通道", value: receiverChannelState, icon: Wifi },
    ...(usesIceServer
      ? [
          { label: "本轮Offer候选", value: formatStoredCandidateSummary(senderCandidateSummary), icon: FileText },
          { label: "本轮Answer候选", value: formatStoredCandidateSummary(receiverCandidateSummary), icon: FileText },
          { label: "发送最终路径", value: formatSelectedPair(senderSelectedPair), icon: Link2 },
          { label: "接收最终路径", value: formatSelectedPair(receiverSelectedPair), icon: Link2 },
          { label: "最终RTT", value: senderSelectedPair.rtt !== "-" ? senderSelectedPair.rtt : receiverSelectedPair.rtt, icon: Gauge },
        ]
      : []),
    { label: "选中文件", value: selectedFile ? selectedFile.name : "未选择", icon: HardDrive },
    { label: "文件大小", value: totalBytes ? formatBytes(totalBytes) : "0 B", icon: Database },
    { label: "已发送", value: formatBytes(sentBytes), icon: UploadCloud },
    { label: "已接收", value: formatBytes(receivedBytes), icon: Download },
    { label: "进度", value: formatPercent(progress), icon: Gauge, progress },
  ];

  const senderCanGenerateOffer = Boolean(selectedFile) && !isSending && turnReady;
  const senderCanApplyAnswer = Boolean(senderAnswerInput.trim() && senderPeerRef.current);
  const receiverCanCreateAnswer = Boolean(receiverOfferInput.trim()) && turnReady;

  const senderOfferSize = useMemo(() => (senderOffer ? `${senderOffer.length.toLocaleString()} 字符` : ""), [senderOffer]);
  const receiverAnswerSize = useMemo(() => (receiverAnswer ? `${receiverAnswer.length.toLocaleString()} 字符` : ""), [receiverAnswer]);

  function updateSenderPeerState(peer: RTCPeerConnection) {
    setSenderPeerState(peer.connectionState);
    setSenderIceState(peer.iceConnectionState);
    setSenderIceGatheringState(peer.iceGatheringState);
  }

  function updateReceiverPeerState(peer: RTCPeerConnection) {
    setReceiverPeerState(peer.connectionState);
    setReceiverIceState(peer.iceConnectionState);
    setReceiverIceGatheringState(peer.iceGatheringState);
  }

  function closeSenderPeer() {
    senderChannelRef.current?.close();
    senderPeerRef.current?.close();
    senderChannelRef.current = null;
    senderPeerRef.current = null;
    setSenderPeerState("new");
    setSenderIceState("new");
    setSenderIceGatheringState("new");
    setSenderChannelState("closed");
    setSenderSelectedPair(emptySelectedPair);
  }

  function closeReceiverPeer() {
    receiverChannelRef.current?.close();
    receiverPeerRef.current?.close();
    receiverChannelRef.current = null;
    receiverPeerRef.current = null;
    receiveChunksRef.current = [];
    receiveMetaRef.current = null;
    receivedBytesRef.current = 0;
    receiveProgressUpdateAtRef.current = 0;
    setIncomingMeta(null);
    setReceiverPeerState("new");
    setReceiverIceState("new");
    setReceiverIceGatheringState("new");
    setReceiverChannelState("closed");
    setReceiverSelectedPair(emptySelectedPair);
  }

  function resetSender() {
    closeSenderPeer();
    setSelectedFile(null);
    setSenderOffer("");
    setSenderAnswerInput("");
    setSenderStatus(config.initialSenderStatus);
    setSenderError("");
    setSenderCandidateSummary(emptyCandidateSummary);
    setSenderProgress(0);
    setSentBytes(0);
    setIsSending(false);
    sendInFlightRef.current = false;
    setSenderHandshakeStage("offer");
  }

  function resetReceiver() {
    closeReceiverPeer();
    setReceiverOfferInput("");
    setReceiverAnswer("");
    setReceiverStatus(config.initialReceiverStatus);
    setReceiverError("");
    setReceiverCandidateSummary(emptyCandidateSummary);
    setReceiverProgress(0);
    setReceivedBytes(0);
  }

  async function probeIceServer(nextRtcConfig = activeRtcConfig) {
    if (!usesIceServer || stunProbeInFlightRef.current) return;
    if (variant === "turn" && !nextRtcConfig.iceServers?.length) {
      setStunProbeError("请先生成 Cloudflare TURN iceServers。");
      return;
    }

    try {
      stunProbeInFlightRef.current = true;
      setIsStunProbing(true);
      setStunProbeError("");
      setStunProbeStatus("步骤1 独立 probe 中");
      setStunProbeSummary(emptyCandidateSummary);
      if (variant === "turn") {
        setTurnProbeTransportSummary(emptyTurnTransportSummary);
        const readyTransports = new Set<TurnTransport>();
        await Promise.allSettled(
          turnTransports.map(async (transport) => {
            const iceServers = filterIceServersByTurnTransport(nextRtcConfig.iceServers ?? [], transport);
            if (iceServers.length === 0) return;

            await observeIceProbe({
              config: { iceServers, iceTransportPolicy: "relay" },
              requiredTypes: config.requiredCandidateTypes,
              timeoutMs: turnProbeGatheringTimeoutMs,
              onSummary: (summary) => {
                setTurnProbeTransportSummary((current) => mergeTurnTransportSummary(current, transport, summary.relay));
                if (transport === turnTransport) setStunProbeSummary(summary);
              },
              onReady: (summary) => {
                readyTransports.add(transport);
                setTurnProbeTransportSummary((current) => mergeTurnTransportSummary(current, transport, summary.relay));
                if (transport === turnTransport) setStunProbeSummary(summary);
                setStunProbeStatus(`步骤1 probe 通过，${transport.toUpperCase()} 已有 relay，继续观察 ICE complete`);
              },
              onComplete: (summary) => {
                setTurnProbeTransportSummary((current) => mergeTurnTransportSummary(current, transport, summary.relay));
                if (transport === turnTransport) setStunProbeSummary(summary);
                setStunProbeStatus("步骤1 probe complete");
              },
            });
          }),
        );

        if (readyTransports.size === 0) {
          throw new Error("UDP/TCP 都没有返回 relay。");
        }
        return;
      }

      await observeIceProbe({
        config: nextRtcConfig,
        requiredTypes: config.requiredCandidateTypes,
        timeoutMs: iceGatheringTimeoutMs,
        onSummary: setStunProbeSummary,
        onReady: (summary) => {
          setStunProbeSummary(summary);
          setStunProbeStatus(`步骤1 probe 通过，继续观察 ICE complete，当前 ${formatStoredCandidateSummary(summary)}`);
        },
        onComplete: (summary) => {
          setStunProbeSummary(summary);
          setStunProbeStatus(`步骤1 probe complete，最终 ${formatStoredCandidateSummary(summary)}`);
        },
      });
    } catch (error) {
      setStunProbeStatus("步骤1 probe 失败");
      setStunProbeError(formatStepError(variant, `步骤1 独立 ${protocolLabel} probe 失败`, error, `${protocolLabel} probe 失败。`));
    } finally {
      stunProbeInFlightRef.current = false;
      setIsStunProbing(false);
    }
  }

  async function generateTurnCredentials() {
    if (variant !== "turn") return;
    const keyId = turnKeyId.trim();
    const apiToken = turnApiToken.trim();
    const ttl = Number(turnTtl);

    if (!keyId || !apiToken) {
      setTurnCredentialError("请填写 Cloudflare TURN Key ID 和 API Token。");
      return;
    }
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) {
      setTurnCredentialError("TTL 请填写 60 到 86400 秒之间的整数。");
      return;
    }

    try {
      setIsGeneratingTurnCredentials(true);
      setTurnCredentialError("");
      setTurnCredentialStatus("正在向 Cloudflare 生成临时 TURN iceServers...");
      setStunProbeSummary(emptyCandidateSummary);
      setTurnProbeTransportSummary(emptyTurnTransportSummary);
      setStunProbeError("");
      const iceServers = await generateCloudflareTurnIceServers(keyId, apiToken, ttl);
      const nextRtcConfig: RTCConfiguration = { iceServers, iceTransportPolicy: "relay" };
      setTurnIceServers(iceServers);
      setTurnCredentialStatus(`已生成 ${iceServers.length} 组 TURN iceServers，TTL ${ttl} 秒。`);
      await probeIceServer(nextRtcConfig);
    } catch (error) {
      setTurnCredentialStatus("TURN iceServers 不可用");
      setTurnCredentialError(error instanceof Error ? error.message : "TURN iceServers 生成或 probe 失败。");
    } finally {
      setIsGeneratingTurnCredentials(false);
    }
  }

  async function updateSelectedCandidatePair(role: "sender" | "receiver", peer: RTCPeerConnection | null) {
    if (!usesIceServer || !peer) return;

    try {
      const pair = await getSelectedCandidatePair(peer);
      if (role === "sender") setSenderSelectedPair(pair);
      else setReceiverSelectedPair(pair);

      if (config.requiredCandidateTypes?.length && !config.requiredCandidateTypes.some((type) => pair.local.includes(type) || pair.remote.includes(type))) {
        const message = `步骤3 最终 ICE candidate pair 不是 ${protocolLabel} ${formatRequiredCandidateTypes(config.requiredCandidateTypes)} 路径，请重新生成信令。`;
        if (role === "sender") setSenderError(message);
        else setReceiverError(message);
      }
    } catch (error) {
      const message = formatStepError(variant, "步骤3 读取最终 candidate pair 失败", error, "读取最终 candidate pair 失败。");
      if (role === "sender") setSenderError(message);
      else setReceiverError(message);
    }
  }

  function handleFile(file: File | null) {
    setSelectedFile(file);
    setSenderProgress(0);
    setSentBytes(0);
    if (file) {
      setSenderStatus(`已选择 ${file.name}，可以生成 ${signalPrefix}Offer。`);
    }
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    handleFile(event.target.files?.[0] ?? null);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    handleFile(event.dataTransfer.files?.[0] ?? null);
  }

  function attachSenderChannel(channel: RTCDataChannel) {
    senderChannelRef.current = channel;
    channel.binaryType = "arraybuffer";
    channel.addEventListener("open", () => {
      setSenderChannelState(channel.readyState);
      setSenderStatus("DataChannel 已打开，准备发送文件。");
      void updateSelectedCandidatePair("sender", senderPeerRef.current);
    });
    channel.addEventListener("close", () => {
      setSenderChannelState(channel.readyState);
    });
    channel.addEventListener("error", () => {
      setSenderError("发送通道发生错误。");
      setSenderChannelState(channel.readyState);
    });
  }

  function attachReceiverChannel(channel: RTCDataChannel) {
    receiverChannelRef.current = channel;
    channel.binaryType = "arraybuffer";
    channel.addEventListener("open", () => {
      setReceiverChannelState(channel.readyState);
      setReceiverStatus("DataChannel 已打开，等待文件数据。");
      void updateSelectedCandidatePair("receiver", receiverPeerRef.current);
    });
    channel.addEventListener("close", () => {
      setReceiverChannelState(channel.readyState);
    });
    channel.addEventListener("error", () => {
      setReceiverError("接收通道发生错误。");
      setReceiverChannelState(channel.readyState);
    });
    channel.addEventListener("message", (event) => {
      void handleReceiverMessage(event.data);
    });
  }

  async function generateOffer() {
    if (!selectedFile) {
      setSenderError("请先选择一个文件。");
      return;
    }
    if (!turnReady) {
      setSenderError("请先生成 Cloudflare TURN iceServers。");
      return;
    }

    try {
      setSenderError("");
      setSenderStatus(config.offerGatheringStatus);
      setSenderOffer("");
      setSenderAnswerInput("");
      setSenderCandidateSummary(emptyCandidateSummary);
      setSenderProgress(0);
      setSentBytes(0);
      closeSenderPeer();

      const peer = createPeerConnection(
        activeRtcConfig,
        updateSenderPeerState,
        setSenderError,
        usesIceServer ? () => undefined : undefined,
      );
      let onIceChange: (() => void) | undefined;
      const ice = collectIceCandidates(peer, () => onIceChange?.());
      senderPeerRef.current = peer;
      attachSenderChannel(peer.createDataChannel("file-transfer", { ordered: true }));

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (variant === "turn") {
        let signalVersion = 0;
        const publishOfferSnapshot = async () => {
          const description = peer.localDescription;
          if (!description) return;

          const version = ++signalVersion;
          const signalParts = createSignalPayloadParts(
            description.toJSON(),
            ice.candidates,
            config.signalCandidateTypes,
            peer.iceGatheringState === "complete",
          );
          setSenderCandidateSummary(signalParts.summary);

          if (!hasRequiredCandidate(signalParts.summary, config.requiredCandidateTypes)) {
            const summary = formatStoredCandidateSummary(signalParts.summary);
            const message = `步骤2 正在收集 ${formatRequiredCandidateTypes(config.requiredCandidateTypes)} 候选，当前 ${summary}。`;
            if (peer.iceGatheringState === "complete") setSenderError(`${config.offerCandidateLabel} 没有收集到 relay 候选。`);
            else setSenderStatus(message);
            return;
          }

          const encoded = await encodeSignal({
            kind: config.signalKind,
            role: "offer",
            description: signalParts.description,
            candidates: signalParts.candidates,
            createdAt: Date.now(),
          });
          if (version !== signalVersion || senderPeerRef.current !== peer) return;

          setSenderOffer(encoded);
          setSenderHandshakeStage("offer");
          setSenderStatus(
            peer.iceGatheringState === "complete"
              ? `步骤2 完整 ${config.offerCandidateLabel} 已生成，信令候选：${formatStoredCandidateSummary(signalParts.summary)}。复制给接收方。`
              : `步骤2 ${config.offerCandidateLabel} 已更新，信令候选：${formatStoredCandidateSummary(signalParts.summary)}。可复制，后续 relay 到达会继续刷新。`,
          );
        };
        const onGatheringChange = () => {
          void publishOfferSnapshot();
          if (peer.iceGatheringState === "complete") {
            peer.removeEventListener("icegatheringstatechange", onGatheringChange);
            ice.stop();
          }
        };
        onIceChange = () => void publishOfferSnapshot();
        peer.addEventListener("icegatheringstatechange", onGatheringChange);
        void publishOfferSnapshot();
        return;
      }

      await waitForIceGathering(
        peer,
        ice,
        iceGatheringTimeoutMs,
      );
      ice.stop();

      if (!peer.localDescription) {
        throw new Error("没有生成本地 Offer。");
      }
      const signalParts = createSignalPayloadParts(
        peer.localDescription.toJSON(),
        ice.candidates,
        config.signalCandidateTypes,
      );
      assertHasCandidates(signalParts.description, signalParts.candidates, config.offerCandidateLabel, config.requiredCandidateTypes);
      setSenderCandidateSummary(signalParts.summary);

      const encoded = await encodeSignal({
        kind: config.signalKind,
        role: "offer",
        description: signalParts.description,
        candidates: signalParts.candidates,
        createdAt: Date.now(),
      });
      setSenderOffer(encoded);
      setSenderHandshakeStage("offer");
      setSenderStatus(`步骤2 完整 ${config.offerCandidateLabel} 已生成，信令候选：${formatStoredCandidateSummary(signalParts.summary)}。复制给接收方。`);
    } catch (error) {
      setSenderError(formatStepError(variant, `步骤2 生成 ${config.offerCandidateLabel} 失败`, error, "生成 Offer 失败。"));
    }
  }

  async function createAnswerFromOffer() {
    if (!turnReady) {
      setReceiverError("请先生成 Cloudflare TURN iceServers。");
      return;
    }

    try {
      setReceiverError("");
      setReceiverStatus(config.answerGatheringStatus);
      setReceiverAnswer("");
      setReceiverCandidateSummary(emptyCandidateSummary);
      setReceiverProgress(0);
      setReceivedBytes(0);
      receiveChunksRef.current = [];
      receiveMetaRef.current = null;
      receivedBytesRef.current = 0;
      closeReceiverPeer();

      const payload = await decodeSignal(receiverOfferInput);
      if (payload.role !== "offer" || payload.description.type !== "offer") {
        throw new Error("粘贴的不是 Offer。");
      }
      if (payload.kind !== config.signalKind) {
        throw new Error(`粘贴的不是 ${protocolLabel} Offer。请确认双方打开的是同一个页面。`);
      }
      if (usesIceServer) {
        assertUsableRemoteCandidates(payload, `发送方 ${config.offerCandidateLabel}`, config.signalCandidateTypes);
      }
      setSenderCandidateSummary(summarizeCandidates(payload.description, payload.candidates));

      const peer = createPeerConnection(
        activeRtcConfig,
        updateReceiverPeerState,
        setReceiverError,
        usesIceServer ? () => undefined : undefined,
      );
      let onIceChange: (() => void) | undefined;
      const ice = collectIceCandidates(peer, () => onIceChange?.());
      receiverPeerRef.current = peer;
      peer.addEventListener("datachannel", (event) => attachReceiverChannel(event.channel));

      await peer.setRemoteDescription(payload.description);
      await addPayloadCandidates(peer, payload);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      if (variant === "turn") {
        let signalVersion = 0;
        const publishAnswerSnapshot = async () => {
          const description = peer.localDescription;
          if (!description) return;

          const version = ++signalVersion;
          const signalParts = createSignalPayloadParts(
            description.toJSON(),
            ice.candidates,
            config.signalCandidateTypes,
            peer.iceGatheringState === "complete",
          );
          setReceiverCandidateSummary(signalParts.summary);

          if (!hasRequiredCandidate(signalParts.summary, config.requiredCandidateTypes)) {
            const summary = formatStoredCandidateSummary(signalParts.summary);
            const message = `步骤2 正在收集 ${formatRequiredCandidateTypes(config.requiredCandidateTypes)} 候选，当前 ${summary}。`;
            if (peer.iceGatheringState === "complete") setReceiverError(`${config.answerCandidateLabel} 没有收集到 relay 候选。`);
            else setReceiverStatus(message);
            return;
          }

          const encoded = await encodeSignal({
            kind: config.signalKind,
            role: "answer",
            description: signalParts.description,
            candidates: signalParts.candidates,
            createdAt: Date.now(),
          });
          if (version !== signalVersion || receiverPeerRef.current !== peer) return;

          setReceiverAnswer(encoded);
          setReceiverStatus(
            peer.iceGatheringState === "complete"
              ? `步骤2 完整 ${config.answerCandidateLabel} 已生成，信令候选：${formatStoredCandidateSummary(signalParts.summary)}。复制给发送方。`
              : `步骤2 ${config.answerCandidateLabel} 已更新，信令候选：${formatStoredCandidateSummary(signalParts.summary)}。可复制，后续 relay 到达会继续刷新。`,
          );
        };
        const onGatheringChange = () => {
          void publishAnswerSnapshot();
          if (peer.iceGatheringState === "complete") {
            peer.removeEventListener("icegatheringstatechange", onGatheringChange);
            ice.stop();
          }
        };
        onIceChange = () => void publishAnswerSnapshot();
        peer.addEventListener("icegatheringstatechange", onGatheringChange);
        void publishAnswerSnapshot();
        return;
      }

      await waitForIceGathering(
        peer,
        ice,
        iceGatheringTimeoutMs,
      );
      ice.stop();

      if (!peer.localDescription) {
        throw new Error("没有生成本地 Answer。");
      }
      const signalParts = createSignalPayloadParts(
        peer.localDescription.toJSON(),
        ice.candidates,
        config.signalCandidateTypes,
      );
      assertHasCandidates(signalParts.description, signalParts.candidates, config.answerCandidateLabel, config.requiredCandidateTypes);
      setReceiverCandidateSummary(signalParts.summary);

      const encoded = await encodeSignal({
        kind: config.signalKind,
        role: "answer",
        description: signalParts.description,
        candidates: signalParts.candidates,
        createdAt: Date.now(),
      });
      setReceiverAnswer(encoded);
      setReceiverStatus(`步骤2 完整 ${config.answerCandidateLabel} 已生成，信令候选：${formatStoredCandidateSummary(signalParts.summary)}。复制给发送方。`);
    } catch (error) {
      setReceiverError(formatStepError(variant, `步骤2 生成 ${config.answerCandidateLabel} 失败`, error, "生成 Answer 失败。"));
    }
  }

  async function applyAnswerToSender() {
    try {
      setSenderError("");
      const peer = senderPeerRef.current;
      if (!peer) {
        throw new Error("请先生成 Offer。");
      }

      const payload = await decodeSignal(senderAnswerInput);
      if (payload.role !== "answer" || payload.description.type !== "answer") {
        throw new Error("粘贴的不是 Answer。");
      }
      if (payload.kind !== config.signalKind) {
        throw new Error(`粘贴的不是 ${protocolLabel} Answer。请确认双方打开的是同一个页面。`);
      }
      if (usesIceServer) {
        assertUsableRemoteCandidates(payload, `接收方 ${config.answerCandidateLabel}`, config.signalCandidateTypes);
      }
      setReceiverCandidateSummary(summarizeCandidates(payload.description, payload.candidates));

      setSenderStatus(usesIceServer ? `步骤3 正在应用 ${config.answerCandidateLabel}，等待 DataChannel 打开...` : "正在应用 Answer，等待 DataChannel 打开...");
      await peer.setRemoteDescription(payload.description);
      await addPayloadCandidates(peer, payload);
      updateSenderPeerState(peer);
      const channel = senderChannelRef.current;
      if (!channel) {
        throw new Error("发送通道不存在，请重新生成 Offer。");
      }
      await waitForDataChannelOpen(
        channel,
        peer,
        {
          timeoutMs: variant === "turn" ? turnChannelOpenTimeoutMs : channelOpenTimeoutMs,
          includeIceState: true,
          onStatus: (message) => setSenderStatus(usesIceServer ? `步骤3 ${message}` : message),
        },
      );
      await updateSelectedCandidatePair("sender", peer);
      await sendSelectedFile();
    } catch (error) {
      setSenderError(formatStepError(variant, `步骤3 建立 ${protocolLabel} 连接失败`, error, "应用 Answer 失败。"));
    }
  }

  async function copySenderOffer() {
    try {
      setSenderError("");
      await copyText(senderOffer);
      setSenderHandshakeStage("answer");
    } catch (error) {
      setSenderError(error instanceof Error ? error.message : "复制 Offer 失败。");
    }
  }

  async function copyReceiverAnswer() {
    try {
      setReceiverError("");
      await copyText(receiverAnswer);
    } catch (error) {
      setReceiverError(error instanceof Error ? error.message : "复制 Answer 失败。");
    }
  }

  async function sendSelectedFile() {
    const file = selectedFile;
    const channel = senderChannelRef.current;
    if (!file || !channel || channel.readyState !== "open" || isSending || sendInFlightRef.current || senderProgress >= 100) return;

    sendInFlightRef.current = true;
    try {
      setIsSending(true);
      setSenderError("");
      setSenderStatus("正在通过 DataChannel 发送文件...");
      setSentBytes(0);
      setSenderProgress(0);

      const meta: TransferMeta = {
        kind: "meta",
        name: file.name,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
      };
      channel.send(JSON.stringify(meta));

      let offset = 0;
      let lastProgressUpdateAt = 0;
      const publishProgress = (bytes: number) => {
        lastProgressUpdateAt = performance.now();
        setSentBytes(bytes);
        setSenderProgress(file.size ? (bytes / file.size) * 100 : 100);
      };

      while (offset < file.size) {
        const buffer = await file.slice(offset, offset + chunkSize).arrayBuffer();
        await waitForBuffer(channel, { highWaterMark, lowWaterMark, onWait: () => publishProgress(offset) });
        channel.send(buffer);
        offset += buffer.byteLength;
        const now = performance.now();
        if (offset >= file.size || channel.bufferedAmount > highWaterMark || now - lastProgressUpdateAt >= progressUpdateIntervalMs) {
          publishProgress(offset);
        }
      }

      const done: TransferDone = { kind: "done" };
      await waitForBuffer(channel, { highWaterMark, lowWaterMark, onWait: () => publishProgress(offset) });
      channel.send(JSON.stringify(done));
      setSentBytes(file.size);
      setSenderProgress(100);
      setSenderStatus("文件已发送完成。");
    } catch (error) {
      setSenderError(error instanceof Error ? error.message : "发送文件失败。");
    } finally {
      sendInFlightRef.current = false;
      setIsSending(false);
    }
  }

  async function handleReceiverMessage(data: unknown) {
    if (typeof data === "string") {
      let message: TransferMeta | TransferDone;
      try {
        message = JSON.parse(data) as TransferMeta | TransferDone;
      } catch {
        setReceiverError("收到无法识别的控制消息。");
        return;
      }

      if (message.kind === "meta") {
        receiveMetaRef.current = message;
        receiveChunksRef.current = [];
        receivedBytesRef.current = 0;
        receiveProgressUpdateAtRef.current = 0;
        setIncomingMeta(message);
        setReceivedBytes(0);
        setReceiverProgress(0);
        setReceiverStatus(`正在接收 ${message.name}。`);
        return;
      }

      if (message.kind === "done") {
        const meta = receiveMetaRef.current;
        if (!meta) {
          setReceiverError("收到完成信号，但缺少文件元数据。请重新传输。");
          return;
        }

        const blob = new Blob(receiveChunksRef.current, {
          type: meta.type || "application/octet-stream",
        });
        const receivedFile: ReceivedFile = {
          id: `${Date.now()}-${meta.name}`,
          name: meta.name,
          size: blob.size,
          type: meta.type,
          url: URL.createObjectURL(blob),
          receivedAt: new Date().toLocaleString(),
        };
        setReceivedFiles((files) => [receivedFile, ...files]);
        setReceiverProgress(100);
        setReceivedBytes(blob.size);
        setReceiverStatus("文件接收完成，已触发浏览器下载。");
        saveBlob(receivedFile);
        receiveChunksRef.current = [];
        receiveMetaRef.current = null;
        setIncomingMeta(null);
      }
      return;
    }

    const meta = receiveMetaRef.current;
    if (!meta) {
      setReceiverError("收到文件数据，但缺少文件元数据。请重新传输。");
      return;
    }

    const buffer = data instanceof ArrayBuffer ? data : await (data as Blob).arrayBuffer();
    receiveChunksRef.current.push(buffer);
    receivedBytesRef.current += buffer.byteLength;
    const received = receivedBytesRef.current;
    const size = meta.size;
    if (size > 0 && received > size) {
      setReceivedBytes(received);
      setReceiverProgress(100);
      setReceiverError(`接收数据超过声明大小：已接收 ${formatBytes(received)}，文件大小 ${formatBytes(size)}。请重新传输。`);
      setReceiverStatus("接收数据异常，已停止保存这个文件。");
      receiveChunksRef.current = [];
      receiveMetaRef.current = null;
      receivedBytesRef.current = 0;
      receiveProgressUpdateAtRef.current = 0;
      setIncomingMeta(null);
      return;
    }

    const now = performance.now();
    if (size === 0 || received >= size || now - receiveProgressUpdateAtRef.current >= progressUpdateIntervalMs) {
      receiveProgressUpdateAtRef.current = now;
      setReceivedBytes(received);
      setReceiverProgress(size ? (received / size) * 100 : 0);
    }
  }

  const senderConnected = senderChannelState === "open" || senderPeerState === "connected";
  const receiverConnected = receiverChannelState === "open" || receiverPeerState === "connected";
  const activeConnected = transferMode === "send" ? senderConnected : transferMode === "receive" ? receiverConnected : false;

  return (
    <TransferPageGrid>
        <StatusPanel>
          {statusPanelView === "details" ? (
            <>
              <StatusPanelHeader
                title="连接详情"
                description="查看当前传输链路、候选地址、通道和文件进度。"
                action={(
                  <SecondaryButton onClick={() => setStatusPanelView("status")}>
                    <ArrowLeft aria-hidden="true" size={17} />
                    返回状态
                  </SecondaryButton>
                )}
              />

              <ConnectionDetails items={details} expanded showHeading={false} />
            </>
          ) : (
            <>
              <StatusPanelHeader
                title="连接状态"
                description={config.description}
                action={(
                  <SecondaryButton
                    onClick={() => {
                      resetSender();
                      resetReceiver();
                      setTransferMode(null);
                      setStatusPanelView("status");
                    }}
                  >
                    <RefreshCw aria-hidden="true" size={17} />
                    重置
                  </SecondaryButton>
                )}
              />

              <TransferSteps steps={transferSteps} />

              <div className="my-5 h-px shrink-0 bg-[#e3edf9]" />

              <ConnectionDetails items={details} onShowMore={() => setStatusPanelView("details")} />
            </>
          )}
        </StatusPanel>

        <MainPanelGrid>
          <ActionPanel>
            <div className="mb-4">
              <h2 className="text-[22px] font-extrabold text-[#061b3a]">选择传输目标</h2>
              <p className="mt-1 text-[15px] text-[#526c92]">先选择当前网页要负责发送还是接收。</p>
            </div>

            {variant === "turn" && (
              <div className="mb-4 grid min-w-0 gap-3 rounded-xl border border-[#d7e5f6] bg-[#f7fbff] p-3">
                <div className="inline-card-header">
                  <div className="min-w-0">
                    <h3 className="truncate text-[15px] font-extrabold text-[#071b3a]">Cloudflare TURN Credentials</h3>
                    <p className="mt-0.5 truncate text-[13px] text-[#526c92]" title={turnCredentialError || turnCredentialStatus}>
                      {turnCredentialError || turnCredentialStatus}
                    </p>
                  </div>
                  <SecondaryButton onClick={() => void generateTurnCredentials()} disabled={isGeneratingTurnCredentials}>
                    <Server aria-hidden="true" size={17} />
                    生成
                  </SecondaryButton>
                </div>
                <div className="adaptive-field-grid">
                  <TextInput label="Key ID" value={turnKeyId} onChange={setTurnKeyId} placeholder="Cloudflare TURN key id" />
                  <TextInput label="API Token" value={turnApiToken} onChange={setTurnApiToken} placeholder="Bearer token" type="password" />
                  <TextInput label="TTL 秒" value={turnTtl} onChange={setTurnTtl} type="number" min={60} max={86400} />
                </div>
              </div>
            )}

            {usesIceServer && (
              <div className="mb-4 grid min-w-0 gap-3 rounded-xl border border-[#d7e5f6] bg-[#f7fbff] p-3">
                <div className="inline-card-header">
                  <div className="min-w-0">
                    <h3 className="truncate text-[15px] font-extrabold text-[#071b3a]">步骤1 {protocolLabel} Probe</h3>
                    <p className="mt-0.5 truncate text-[13px] text-[#526c92]" title={stunProbeError || stunProbeStatus}>
                      {stunProbeError || stunProbeStatus}
                    </p>
                  </div>
                  <SecondaryButton onClick={() => void probeIceServer()} disabled={isStunProbing || !hasTurnIceServers}>
                    <Server aria-hidden="true" size={17} />
                    Probe
                  </SecondaryButton>
                </div>
                <div className="probe-stat-grid text-[13px]">
                  {variant === "turn"
                    ? ([
                        ["udp", "UDP", turnProbeTransportSummary.udp],
                        ["tcp", "TCP", turnProbeTransportSummary.tcp],
                        ["total", "Total", turnProbeTransportSummary.total],
                      ] as const).map(([key, label, value]) => {
                        const selectable = key !== "total";
                        const selected = key === turnTransport;
                        return (
                          <button
                            className={`min-w-0 rounded-lg border px-2 py-2 text-center transition ${
                              selected
                                ? "border-[#1677ff] bg-[#eaf4ff] text-[#0d63da] shadow-[0_8px_18px_rgba(47,125,246,0.12)]"
                                : "border-[#dfeaf7] bg-white text-[#142a4f] hover:border-[#9ec7ff]"
                            } ${selectable ? "" : "cursor-default hover:border-[#dfeaf7]"}`}
                            disabled={!selectable}
                            key={key}
                            onClick={() => {
                              if (!selectable || key === turnTransport) return;
                              setTurnTransport(key);
                              resetSender();
                              resetReceiver();
                              setTransferMode(null);
                            }}
                            type="button"
                          >
                            <span className="block min-w-0 truncate text-[#6a7f9e]">{label}</span>
                            <strong className="text-[15px]">{value}</strong>
                          </button>
                        );
                      })
                    : (["host", "srflx", "relay", "total"] as const).map((key) => (
                        <span className="min-w-0 rounded-lg border border-[#dfeaf7] bg-white px-2 py-2" key={key}>
                          <span className="block min-w-0 truncate text-[#6a7f9e]">{key}</span>
                          <strong className="text-[15px] text-[#142a4f]">{stunProbeSummary[key]}</strong>
                        </span>
                      ))}
                </div>
              </div>
            )}

            {!transferMode && (
              <div className="grid gap-3">
                <RoleOption
                  title="发送文件"
                  description={`生成 ${signalPrefix}Offer，等待接收方 Answer`}
                  icon={UploadCloud}
                  selected={transferMode === "send"}
                  onClick={() => {
                    setTransferMode("send");
                    setSenderHandshakeStage(senderOffer ? "answer" : "offer");
                  }}
                />
                <RoleOption
                  title="接收文件"
                  description={`粘贴 ${signalPrefix}Offer，生成 Answer`}
                  icon={Download}
                  selected={transferMode === "receive"}
                  onClick={() => {
                    setSelectedFile(null);
                    setSenderProgress(0);
                    setSentBytes(0);
                    setTransferMode("receive");
                  }}
                />
              </div>
            )}

            {transferMode && activeConnected && (
              <div className="grid min-h-[220px] place-items-center rounded-2xl border border-[#b9dcff] bg-[#f1f8ff] px-5 py-5 text-center">
                <span className="grid size-[56px] place-items-center rounded-2xl bg-[#1677ff] text-white shadow-[0_14px_30px_rgba(47,125,246,0.24)]">
                  <Check aria-hidden="true" size={29} />
                </span>
                <div>
                  <h3 className="mt-3 text-[20px] font-extrabold text-[#061b3a]">已连接</h3>
                  <p className="mt-1 text-[14px] text-[#526c92]">
                    {transferMode === "send"
                      ? `${signalPrefix}Answer 已应用，文件会通过 DataChannel 发送。`
                      : "接收通道已打开，等待发送方传输文件。"}
                  </p>
                </div>
                <div className="mt-4 w-full rounded-xl border border-[#d7e5f6] bg-white px-4 py-3 text-left">
                  <div className="mb-2.5 flex items-center justify-between gap-3">
                    <h3 className="text-[16px] font-extrabold text-[#071b3a]">{transferMode === "send" ? "发送进度" : "接收进度"}</h3>
                    <span className="text-[14px] font-medium text-[#526c92]">{formatPercent(transferMode === "send" ? senderProgress : receiverProgress)}</span>
                  </div>
                  <div className="h-2 rounded-full bg-[#dce8f7]">
                    <span className="block h-full rounded-full bg-[#1677ff]" style={{ width: `${transferMode === "send" ? senderProgress : receiverProgress}%` }} />
                  </div>
                  <div className="mt-2.5 flex justify-between gap-3 text-[14px] text-[#526c92]">
                    <span>{transferMode === "send" ? formatBytes(sentBytes) : formatBytes(receivedBytes)}</span>
                    <span>{formatBytes(totalBytes)}</span>
                  </div>
                </div>
              </div>
            )}

            {transferMode === "send" && !activeConnected && (
              <div className="grid gap-4">
                {senderHandshakeStage === "offer" ? (
                  <>
                    <TextArea
                      label={`发送方 ${signalPrefix}Offer ${senderOfferSize}`}
                      value={senderOffer}
                      onChange={setSenderOffer}
                      placeholder={`选择文件并生成 ${signalPrefix}Offer 后，把这一整串文本复制给接收方`}
                      readOnly
                    />
                    <div className="flex flex-wrap gap-3">
                      <PrimaryButton onClick={generateOffer} disabled={!senderCanGenerateOffer}>
                        <Send aria-hidden="true" size={17} />
                        生成 {signalPrefix}Offer
                      </PrimaryButton>
                      <SecondaryButton onClick={() => void copySenderOffer()} disabled={!senderOffer}>
                        <Copy aria-hidden="true" size={17} />
                        复制 {signalPrefix}Offer
                      </SecondaryButton>
                    </div>
                  </>
                ) : (
                  <>
                    <TextArea
                      label={`接收方 ${signalPrefix}Answer`}
                      value={senderAnswerInput}
                      onChange={setSenderAnswerInput}
                      placeholder={`把接收方生成的 ${signalPrefix}Answer 粘贴到这里`}
                    />
                    <div className="flex flex-wrap gap-3">
                      <SecondaryButton onClick={() => setSenderHandshakeStage("offer")}>
                        <FileText aria-hidden="true" size={17} />
                        查看 {signalPrefix}Offer
                      </SecondaryButton>
                      <PrimaryButton onClick={applyAnswerToSender} disabled={!senderCanApplyAnswer}>
                        <Link2 aria-hidden="true" size={17} />
                        发送
                      </PrimaryButton>
                    </div>
                  </>
                )}
                <StatusMessage message={senderError || senderStatus} tone={senderError ? "error" : "info"} />
              </div>
            )}

            {transferMode === "receive" && !activeConnected && (
              <div className="grid gap-4">
                {receiverAnswer ? (
                  <>
                    <TextArea
                      label={`接收方 ${signalPrefix}Answer ${receiverAnswerSize}`}
                      value={receiverAnswer}
                      onChange={setReceiverAnswer}
                      placeholder="生成后复制这一整串文本给发送方"
                      readOnly
                    />
                    <div className="flex flex-wrap gap-3">
                      <SecondaryButton onClick={() => setReceiverAnswer("")}>
                        <FileText aria-hidden="true" size={17} />
                        修改 {signalPrefix}Offer
                      </SecondaryButton>
                      <PrimaryButton onClick={() => void copyReceiverAnswer()} disabled={!receiverAnswer}>
                        <Copy aria-hidden="true" size={17} />
                        复制 {signalPrefix}Answer
                      </PrimaryButton>
                    </div>
                  </>
                ) : (
                  <>
                    <TextArea
                      label={`发送方 ${signalPrefix}Offer`}
                      value={receiverOfferInput}
                      onChange={setReceiverOfferInput}
                      placeholder={`把发送方 ${signalPrefix}Offer 粘贴到这里`}
                    />
                    <div className="flex flex-wrap gap-3">
                      <PrimaryButton onClick={createAnswerFromOffer} disabled={!receiverCanCreateAnswer}>
                        <Link2 aria-hidden="true" size={17} />
                        生成 {signalPrefix}Answer
                      </PrimaryButton>
                    </div>
                  </>
                )}
                <StatusMessage message={receiverError || receiverStatus} tone={receiverError ? "error" : "info"} />
              </div>
            )}
          </ActionPanel>

          <UploadPanel>
            <FilePickerPanel
              inputRef={senderFileInputRef}
              onFileInput={handleFileInput}
              onDrop={handleDrop}
              ariaLabel={transferMode === "send" ? "选择发送文件" : "文件选择状态"}
              title={selectedFile?.name}
              titleFallback={
                transferMode === "receive"
                  ? "接收端无需选择文件"
                  : transferMode === "send"
                    ? "点击或拖拽文件到此处上传"
                    : "先选择发送文件角色"
              }
              subtitle={
                transferMode === "receive"
                  ? "等待发送方通过 DataChannel 传输文件"
                  : transferMode === "send"
                    ? selectedFile
                      ? formatBytes(selectedFile.size)
                      : `选择发送文件后再生成 ${signalPrefix}Offer`
                    : "选择左侧发送文件后启用文件选择"
              }
              onSelect={() => senderFileInputRef.current?.click()}
              disabled={transferMode !== "send"}
              icon={transferMode === "receive" ? Download : UploadCloud}
            />
          </UploadPanel>
        </MainPanelGrid>

        <FilesPanel>
          <ReceivedFilesPanel
            title="已接收文件"
            countLabel={`${receivedFiles.length} 个文件`}
            ariaLabel="已接收文件列表"
            emptyText="接收完成后，文件会出现在这里并自动触发下载。"
            files={receivedFiles}
            formatSize={formatBytes}
            onDownload={saveBlob}
          />
        </FilesPanel>
    </TransferPageGrid>
  );
  };
}
