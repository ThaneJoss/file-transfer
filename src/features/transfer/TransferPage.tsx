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
import type { ChangeEvent, DragEvent, ReactNode } from "react";

import { PrimaryButton, SecondaryButton, StatusMessage, TextArea, TextInput } from "../../component/TransferControls";
import { generateCloudflareTurnIceServers } from "../turn/services/cloudflareTurn";
import { decodeConnectionPayload, encodeConnectionPayload } from "./protocol/connectionCode";
import { waitForBuffer, waitForDataChannelOpen } from "./services/dataChannel";
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
} from "../../layout/TransferLayout";
import type { MetricItem, TransferStepItem } from "../../layout/TransferLayout";
import { notifyApiUsageChanged } from "../../lib/api/client";
import { useAuth } from "../../lib/auth/AuthProvider";
import { copyText } from "../../lib/browser/clipboard";
import { saveBlob } from "../../lib/browser/download";
import { formatBytes, formatPercent } from "../../lib/files/format";
import {
  createPickup,
  getPickup,
  getPickupAnswer,
  recordTransferUsage,
  submitPickupAnswer,
} from "./services/pickupApi";
import type { PendingPickup, PickupVariant } from "./services/pickupApi";

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
export type WebRtcTransferVariant = "direct" | "stun" | "turn";

type CandidateSummary = {
  host: number;
  srflx: number;
  relay: number;
  total: number;
};

type CandidateType = "host" | "srflx" | "relay";
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

const transferVariantConfig: Record<WebRtcTransferVariant, TransferVariantConfig> = {
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
    signalCandidateTypes: ["host", "srflx", "relay"],
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
const channelOpenTimeoutMs = 18000;
const turnChannelOpenTimeoutMs = 90000;
const defaultTurnCredentialTtlSeconds = 3600;

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

function formatStepError(variant: WebRtcTransferVariant, step: string, error: unknown, fallback: string) {
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

function isWebRtcPickupVariant(variant: PickupVariant): variant is WebRtcTransferVariant {
  return variant === "direct" || variant === "stun" || variant === "turn";
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

export function TransferPage({
  variant,
  methodSelector,
  pendingPickup,
  onPickupVariantResolved,
}: {
  variant: WebRtcTransferVariant;
  methodSelector?: ReactNode;
  pendingPickup?: PendingPickup | null;
  onPickupVariantResolved?: (pending: PendingPickup) => void;
}) {
  const { session } = useAuth();
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
  const senderFileInputRef = useRef<HTMLInputElement | null>(null);
  const selectedFileRef = useRef<File | null>(null);
  const pickupPollGenerationRef = useRef(0);
  const transferIdRef = useRef(crypto.randomUUID());

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
  const [senderSelectedPair, setSenderSelectedPair] = useState<SelectedCandidatePair>(emptySelectedPair);
  const [receiverSelectedPair, setReceiverSelectedPair] = useState<SelectedCandidatePair>(emptySelectedPair);
  const [turnIceServers, setTurnIceServers] = useState<RTCIceServer[]>([]);
  const [isGeneratingTurnCredentials, setIsGeneratingTurnCredentials] = useState(false);
  const [senderPickupCode, setSenderPickupCode] = useState("");
  const [receiverPickupInput, setReceiverPickupInput] = useState("");
  const [receiverPickupCode, setReceiverPickupCode] = useState("");
  const [pickupExpiresAt, setPickupExpiresAt] = useState<number | null>(null);
  const [isPickupBusy, setIsPickupBusy] = useState(false);
  const pickupEnabled = Boolean(session?.user);
  const consumedPendingPickupRef = useRef("");

  const activeRtcConfig = useMemo<RTCConfiguration>(
    () =>
      variant === "turn"
        ? { iceServers: turnIceServers, iceTransportPolicy: "relay" }
        : config.rtcConfig,
    [config.rtcConfig, turnIceServers, variant],
  );
  const serverLabel =
    variant === "turn"
      ? turnIceServers.length > 0
        ? "已准备临时 TURN relay 配置"
        : "生成 Offer/Answer 时自动申请"
      : config.serverLabel;

  useEffect(() => {
    return () => {
      senderPeerRef.current?.close();
      receiverPeerRef.current?.close();
      pickupPollGenerationRef.current += 1;
      receivedFilesRef.current.forEach((file) => URL.revokeObjectURL(file.url));
    };
  }, []);

  useEffect(() => {
    receivedFilesRef.current = receivedFiles;
  }, [receivedFiles]);

  const totalBytes = selectedFile?.size ?? incomingMeta?.size ?? 0;
  const progress = Math.max(senderProgress, receiverProgress);
  const combinedCandidateSummary = mergeCandidateSummaries(senderCandidateSummary, receiverCandidateSummary);
  const combinedServerSummary = combinedCandidateSummary;
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
              : isGeneratingTurnCredentials
                ? "准备中"
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

  const senderCanGenerateOffer = Boolean(selectedFile) && !isSending && !isGeneratingTurnCredentials && !isPickupBusy;
  const senderCanApplyAnswer = Boolean(senderAnswerInput.trim() && senderPeerRef.current);
  const receiverCanCreateAnswer = Boolean(receiverOfferInput.trim()) && !isGeneratingTurnCredentials;

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
    pickupPollGenerationRef.current += 1;
    closeSenderPeer();
    selectedFileRef.current = null;
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
    setSenderPickupCode("");
    setPickupExpiresAt(null);
    setIsPickupBusy(false);
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
    setReceiverPickupInput("");
    setReceiverPickupCode("");
    setIsPickupBusy(false);
  }

  async function prepareRtcConfig(role: "sender" | "receiver") {
    if (variant !== "turn") return activeRtcConfig;
    if (turnIceServers.length > 0) return activeRtcConfig;

    const setStatus = role === "sender" ? setSenderStatus : setReceiverStatus;
    setStatus("正在申请临时 TURN relay 配置...");
    setIsGeneratingTurnCredentials(true);
    try {
      const fileSizeBytes = role === "sender" ? selectedFile?.size : undefined;
      const iceServers = await generateCloudflareTurnIceServers(defaultTurnCredentialTtlSeconds, fileSizeBytes);
      const nextRtcConfig: RTCConfiguration = { iceServers, iceTransportPolicy: "relay" };
      setTurnIceServers(iceServers);
      setStatus("临时 TURN relay 配置已准备，正在生成信令...");
      return nextRtcConfig;
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
    selectedFileRef.current = file;
    setSelectedFile(file);
    setSenderProgress(0);
    setSentBytes(0);
    if (file) {
      if (pickupEnabled) {
        setSenderStatus(`已选择 ${file.name}，正在生成取件码...`);
        void generateOffer(file);
      } else {
        setSenderStatus(`已选择 ${file.name}，可以生成 ${signalPrefix}Offer。`);
      }
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

  async function publishPickupOffer(encoded: string) {
    if (!pickupEnabled) return false;
    setSenderStatus("Offer 已生成，正在写入 Durable Object...");
    const pickup = await createPickup(variant, encoded);
    setSenderPickupCode(pickup.code);
    setPickupExpiresAt(pickup.expiresAt);
    setSenderStatus(`取件码 ${pickup.code} 已生成，等待接收方输入。`);
    startPickupAnswerPolling(pickup.code);
    return true;
  }

  function startPickupAnswerPolling(code: string) {
    const generation = pickupPollGenerationRef.current + 1;
    pickupPollGenerationRef.current = generation;
    const poll = async () => {
      if (pickupPollGenerationRef.current !== generation) return;
      try {
        const result = await getPickupAnswer(code);
        if (pickupPollGenerationRef.current !== generation) return;
        if (result.answer) {
          pickupPollGenerationRef.current += 1;
          setSenderAnswerInput(result.answer);
          setSenderStatus("已取得接收方 Answer，正在建立 DataChannel...");
          await applyAnswerToSender(result.answer);
          return;
        }
        window.setTimeout(() => void poll(), 2000);
      } catch (error) {
        if (pickupPollGenerationRef.current !== generation) return;
        pickupPollGenerationRef.current += 1;
        setSenderError(error instanceof Error ? error.message : "读取取件码 Answer 失败。");
      }
    };
    window.setTimeout(() => void poll(), 1000);
  }

  async function generateOffer(fileOverride?: File) {
    const file = fileOverride ?? selectedFile;
    if (!file) {
      setSenderError("请先选择一个文件。");
      return;
    }

    try {
      if (pickupEnabled) setIsPickupBusy(true);
      setSenderError("");
      setSenderPickupCode("");
      setPickupExpiresAt(null);
      pickupPollGenerationRef.current += 1;
      transferIdRef.current = crypto.randomUUID();
      const rtcConfig = await prepareRtcConfig("sender");
      setSenderStatus(config.offerGatheringStatus);
      setSenderOffer("");
      setSenderAnswerInput("");
      setSenderCandidateSummary(emptyCandidateSummary);
      setSenderProgress(0);
      setSentBytes(0);
      closeSenderPeer();

      const peer = createPeerConnection(
        rtcConfig,
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
        let pickupPublished = false;
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
          if (pickupEnabled && !pickupPublished) {
            pickupPublished = true;
            try {
              await publishPickupOffer(encoded);
            } catch (error) {
              pickupPublished = false;
              setSenderError(formatStepError(variant, `步骤2 写入 ${config.offerCandidateLabel} 取件码失败`, error, "写入取件码失败。"));
            }
            return;
          }
          setSenderStatus(
            pickupEnabled
              ? `取件码 ${senderPickupCode || "已生成"} 已更新为可连接的 TURN Offer，等待接收方输入。`
              : peer.iceGatheringState === "complete"
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
      if (!(await publishPickupOffer(encoded))) {
        setSenderStatus(`步骤2 完整 ${config.offerCandidateLabel} 已生成，信令候选：${formatStoredCandidateSummary(signalParts.summary)}。复制给接收方。`);
      }
    } catch (error) {
      setSenderError(formatStepError(variant, `步骤2 生成 ${config.offerCandidateLabel} 失败`, error, "生成 Offer 失败。"));
    } finally {
      if (pickupEnabled) setIsPickupBusy(false);
    }
  }

  async function createAnswerFromOffer(
    offerOverride = receiverOfferInput,
    pickupCodeOverride = receiverPickupCode,
  ) {
    try {
      setReceiverError("");
      const payload = await decodeSignal(offerOverride);
      if (payload.role !== "offer" || payload.description.type !== "offer") {
        throw new Error("粘贴的不是 Offer。");
      }
      if (payload.kind !== config.signalKind) {
        throw new Error(`粘贴的不是 ${protocolLabel} Offer。请确认双方打开的是同一个页面。`);
      }
      if (usesIceServer) {
        assertUsableRemoteCandidates(payload, `发送方 ${config.offerCandidateLabel}`, config.signalCandidateTypes);
      }
      const rtcConfig = await prepareRtcConfig("receiver");
      setReceiverStatus(config.answerGatheringStatus);
      setReceiverAnswer("");
      setReceiverCandidateSummary(emptyCandidateSummary);
      setReceiverProgress(0);
      setReceivedBytes(0);
      receiveChunksRef.current = [];
      receiveMetaRef.current = null;
      receivedBytesRef.current = 0;
      closeReceiverPeer();
      setSenderCandidateSummary(summarizeCandidates(payload.description, payload.candidates));

      const peer = createPeerConnection(
        rtcConfig,
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
        let pickupAnswerSubmitted = false;
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
          if (pickupCodeOverride && !pickupAnswerSubmitted) {
            pickupAnswerSubmitted = true;
            try {
              await submitPickupAnswer(pickupCodeOverride, encoded);
              setReceiverStatus("Answer 已写入取件码，等待发送方建立 DataChannel。");
            } catch (error) {
              pickupAnswerSubmitted = false;
              setReceiverError(formatStepError(variant, `步骤2 写入 ${config.answerCandidateLabel} 失败`, error, "写入 Answer 失败。"));
            }
            return;
          }
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
      if (pickupCodeOverride) {
        await submitPickupAnswer(pickupCodeOverride, encoded);
        setReceiverStatus("Answer 已写入取件码，等待发送方建立 DataChannel。");
      } else {
        setReceiverStatus(`步骤2 完整 ${config.answerCandidateLabel} 已生成，信令候选：${formatStoredCandidateSummary(signalParts.summary)}。复制给发送方。`);
      }
    } catch (error) {
      setReceiverError(formatStepError(variant, `步骤2 生成 ${config.answerCandidateLabel} 失败`, error, "生成 Answer 失败。"));
    }
  }

  async function receiveWithPickupCode() {
    const code = receiverPickupInput.trim();
    if (!/^\d{8}$/.test(code)) {
      setReceiverError("取件码必须是 8 位数字。");
      return;
    }
    try {
      setIsPickupBusy(true);
      setReceiverError("");
      setReceiverStatus("正在读取取件码...");
      const pickup = await getPickup(code);
      if (pickup.variant !== variant) {
        onPickupVariantResolved?.({ code, pickup });
        setReceiverStatus(`取件码属于 ${pickup.variant.toUpperCase()}，正在切换传输方法。`);
        return;
      }
      setReceiverPickupCode(code);
      setReceiverOfferInput(pickup.offer);
      await createAnswerFromOffer(pickup.offer, code);
    } catch (error) {
      setReceiverError(error instanceof Error ? error.message : "读取取件码失败。");
    } finally {
      setIsPickupBusy(false);
    }
  }

  useEffect(() => {
    if (!pendingPickup || pendingPickup.pickup.variant !== variant) return;
    if (!isWebRtcPickupVariant(pendingPickup.pickup.variant)) return;
    const key = `${pendingPickup.code}:${pendingPickup.pickup.variant}:${pendingPickup.pickup.expiresAt}:${pendingPickup.pickup.offer}`;
    if (consumedPendingPickupRef.current === key) return;
    consumedPendingPickupRef.current = key;
    setTransferMode("receive");
    setReceiverPickupInput(pendingPickup.code);
    setReceiverPickupCode(pendingPickup.code);
    setReceiverOfferInput(pendingPickup.pickup.offer);
    setIsPickupBusy(true);
    setReceiverStatus(`已读取 ${pendingPickup.pickup.variant.toUpperCase()} 取件码，正在生成 Answer...`);
    void createAnswerFromOffer(pendingPickup.pickup.offer, pendingPickup.code).finally(() => {
      setIsPickupBusy(false);
    });
  }, [pendingPickup, variant]);

  async function applyAnswerToSender(answerOverride = senderAnswerInput) {
    try {
      setSenderError("");
      const peer = senderPeerRef.current;
      if (!peer) {
        throw new Error("请先生成 Offer。");
      }

      const payload = await decodeSignal(answerOverride);
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

  async function copyPickupCode() {
    try {
      setSenderError("");
      await copyText(senderPickupCode);
      setSenderStatus(`取件码 ${senderPickupCode} 已复制。`);
    } catch (error) {
      setSenderError(error instanceof Error ? error.message : "复制取件码失败。");
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
    const file = selectedFileRef.current;
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
      if ((variant === "direct" || variant === "stun") && session?.user) {
        try {
          await recordTransferUsage(variant, file.size, transferIdRef.current);
        } catch (error) {
          setSenderError(
            `文件已发送完成，但流量上报失败：${error instanceof Error ? error.message : "未知错误"}`,
          );
        }
      } else if (variant === "turn") {
        notifyApiUsageChanged();
      }
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
        if (variant === "turn") notifyApiUsageChanged();
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
                description={
                  pickupEnabled
                    ? `${protocolLabel} DataChannel 传输，使用 8 位取件码自动交换 Offer / Answer。`
                    : config.description
                }
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

            {!transferMode && (
              <div className="grid gap-3">
                <RoleOption
                  title="发送文件"
                  description={pickupEnabled ? "选择文件后生成 8 位取件码" : `生成 ${signalPrefix}Offer，等待接收方 Answer`}
                  icon={UploadCloud}
                  selected={transferMode === "send"}
                  onClick={() => {
                    setTransferMode("send");
                    setSenderHandshakeStage(senderOffer ? "answer" : "offer");
                  }}
                />
                {methodSelector}
                <RoleOption
                  title="接收文件"
                  description={pickupEnabled ? "输入 8 位取件码自动识别方法" : `粘贴 ${signalPrefix}Offer，生成 Answer`}
                  icon={Download}
                  selected={transferMode === "receive"}
                  onClick={() => {
                    selectedFileRef.current = null;
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
                {pickupEnabled ? (
                  <>
                    <div className="grid min-h-[150px] place-items-center rounded-2xl border border-[#b9dcff] bg-[#f1f8ff] p-5 text-center">
                      <div>
                        <div className="text-sm font-bold text-[#526c92]">8 位取件码</div>
                        <div
                          className="mt-2 font-mono text-[36px] font-black tracking-[0.18em] text-[#061b3a]"
                          data-testid="sender-pickup-code"
                        >
                          {senderPickupCode || (isPickupBusy ? "生成中" : "--------")}
                        </div>
                        <div className="mt-2 text-xs text-[#526c92]">
                          {pickupExpiresAt
                            ? `有效至 ${new Date(pickupExpiresAt).toLocaleTimeString("zh-CN")}`
                            : "选择文件后自动生成"}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <PrimaryButton onClick={() => void generateOffer()} disabled={!senderCanGenerateOffer}>
                        <Send aria-hidden="true" size={17} />
                        {senderPickupCode ? "重新生成取件码" : "生成取件码"}
                      </PrimaryButton>
                      <SecondaryButton onClick={() => void copyPickupCode()} disabled={!senderPickupCode}>
                        <Copy aria-hidden="true" size={17} />
                        复制取件码
                      </SecondaryButton>
                    </div>
                  </>
                ) : senderHandshakeStage === "offer" ? (
                  <>
                    <TextArea
                      label={`发送方 ${signalPrefix}Offer ${senderOfferSize}`}
                      value={senderOffer}
                      onChange={setSenderOffer}
                      placeholder={`选择文件并生成 ${signalPrefix}Offer 后，把这一整串文本复制给接收方`}
                      readOnly
                    />
                    <div className="flex flex-wrap gap-3">
                      <PrimaryButton onClick={() => void generateOffer()} disabled={!senderCanGenerateOffer}>
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
                      <PrimaryButton onClick={() => void applyAnswerToSender()} disabled={!senderCanApplyAnswer}>
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
                {pickupEnabled ? (
                  <>
                    <TextInput
                      label="8 位取件码"
                      value={receiverPickupInput}
                      onChange={(value) => setReceiverPickupInput(value.replace(/\D/g, "").slice(0, 8))}
                      placeholder="输入发送方提供的 8 位数字"
                    />
                    <div className="flex flex-wrap gap-3">
                      <PrimaryButton
                        onClick={() => void receiveWithPickupCode()}
                        disabled={receiverPickupInput.length !== 8 || isPickupBusy}
                      >
                        <Download aria-hidden="true" size={17} />
                        {isPickupBusy ? "连接中..." : "取件并连接"}
                      </PrimaryButton>
                    </div>
                  </>
                ) : receiverAnswer ? (
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
                      <PrimaryButton onClick={() => void createAnswerFromOffer()} disabled={!receiverCanCreateAnswer}>
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
}
