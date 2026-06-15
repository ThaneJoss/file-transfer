import {
  Check,
  Circle,
  Copy,
  Database,
  Download,
  FileText,
  Gauge,
  HardDrive,
  Link2,
  Monitor,
  RefreshCw,
  Send,
  UploadCloud,
  Wifi,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";

import { Panel } from "../components/Panel";

type SignalPayload = {
  kind: "direct-webrtc-signal";
  role: "offer" | "answer";
  description: RTCSessionDescriptionInit;
  candidates?: RTCIceCandidateInit[];
  createdAt: number;
};

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

type TransferStep = {
  label: string;
  meta: string;
  icon: typeof Monitor;
  active: boolean;
};

type DetailItem = {
  label: string;
  value: string;
  icon: typeof Link2;
  status?: "online";
  progress?: number;
};

type TransferMode = "send" | "receive" | null;
type SenderHandshakeStage = "offer" | "answer";

const rtcConfig: RTCConfiguration = { iceServers: [] };
const chunkSize = 64 * 1024;
const highWaterMark = 8 * 1024 * 1024;
const lowWaterMark = 2 * 1024 * 1024;
const iceGatheringTimeoutMs = 30000;
const channelOpenTimeoutMs = 18000;

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function formatPercent(value: number) {
  return `${Math.max(0, Math.min(100, value)).toFixed(0)}%`;
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function encodeSignal(payload: SignalPayload) {
  const json = JSON.stringify(payload);
  const compression = globalThis.CompressionStream;
  if (!compression) {
    return `J1.${bytesToBase64Url(new TextEncoder().encode(json))}`;
  }

  const stream = new Blob([json]).stream().pipeThrough(new compression("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return `D1.${bytesToBase64Url(new Uint8Array(buffer))}`;
}

async function decodeSignal(value: string): Promise<SignalPayload> {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("请先粘贴连接文本。");
  }

  if (trimmed.startsWith("J1.")) {
    const json = new TextDecoder().decode(base64UrlToBytes(trimmed.slice(3)));
    return parseSignal(json);
  }

  if (trimmed.startsWith("D1.")) {
    const decompression = globalThis.DecompressionStream;
    if (!decompression) {
      throw new Error("当前浏览器不能解压 D1 连接文本，请换用最新版 Chrome、Edge 或 Safari。");
    }
    const bytes = base64UrlToBytes(trimmed.slice(3));
    const stream = new Blob([bytes]).stream().pipeThrough(new decompression("gzip"));
    const json = await new Response(stream).text();
    return parseSignal(json);
  }

  return parseSignal(trimmed);
}

function parseSignal(json: string): SignalPayload {
  const payload = JSON.parse(json) as SignalPayload;
  if (payload.kind !== "direct-webrtc-signal" || !payload.description?.type || !payload.description.sdp) {
    throw new Error("连接文本格式不正确。");
  }
  return payload;
}

function summarizeCandidates(
  description: RTCSessionDescriptionInit | null,
  candidates: RTCIceCandidateInit[] = [],
) {
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
    if (/\styp host(\s|$)/.test(candidate)) summary.host += 1;
    if (/\styp srflx(\s|$)/.test(candidate)) summary.srflx += 1;
    if (/\styp relay(\s|$)/.test(candidate)) summary.relay += 1;
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

function assertHasCandidates(
  description: RTCSessionDescriptionInit | null,
  candidates: RTCIceCandidateInit[],
  label: string,
) {
  const summary = summarizeCandidates(description, candidates);
  if (summary.total === 0) {
    throw new Error(`${label} 没有包含 ICE candidate，请刷新页面后重新生成。`);
  }
}

function collectIceCandidates(peer: RTCPeerConnection) {
  const candidates: RTCIceCandidateInit[] = [];
  const onCandidate = (event: RTCPeerConnectionIceEvent) => {
    if (event.candidate) {
      candidates.push(event.candidate.toJSON());
    }
  };
  peer.addEventListener("icecandidate", onCandidate);
  return {
    candidates,
    stop: () => peer.removeEventListener("icecandidate", onCandidate),
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
}

function createPeerConnection(
  onState: (peer: RTCPeerConnection) => void,
  onError: (message: string) => void,
) {
  const peer = new RTCPeerConnection(rtcConfig);
  const notify = () => onState(peer);
  peer.addEventListener("connectionstatechange", notify);
  peer.addEventListener("iceconnectionstatechange", notify);
  peer.addEventListener("signalingstatechange", notify);
  peer.addEventListener("icegatheringstatechange", notify);
  peer.addEventListener("icecandidateerror", (event) => {
    onError(`ICE 候选收集失败：${event.errorText || event.errorCode}`);
  });
  return peer;
}

function waitForIceGathering(peer: RTCPeerConnection, timeoutMs = iceGatheringTimeoutMs) {
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
      done(new Error("ICE candidate 收集没有完成，请刷新页面后重新生成完整 Offer/Answer。"));
    }, timeoutMs);
    peer.addEventListener("icegatheringstatechange", onChange);
  });
}

function waitForDataChannelOpen(
  channel: RTCDataChannel,
  peer: RTCPeerConnection,
  timeoutMs = channelOpenTimeoutMs,
) {
  if (channel.readyState === "open") return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let finished = false;
    const done = (error?: Error) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      channel.removeEventListener("open", onOpen);
      channel.removeEventListener("close", onClose);
      channel.removeEventListener("error", onError);
      peer.removeEventListener("iceconnectionstatechange", onIceState);
      peer.removeEventListener("connectionstatechange", onPeerState);
      if (error) reject(error);
      else resolve();
    };
    const onOpen = () => done();
    const onClose = () => done(new Error("DataChannel 已关闭，连接没有建立。"));
    const onError = () => done(new Error("DataChannel 发生错误，连接没有建立。"));
    const onIceState = () => {
      if (peer.iceConnectionState === "failed" || peer.iceConnectionState === "closed") {
        done(new Error(`ICE 连接失败：${peer.iceConnectionState}。请确认发送方粘贴的是这次生成的 Answer。`));
      }
    };
    const onPeerState = () => {
      if (peer.connectionState === "failed" || peer.connectionState === "closed") {
        done(new Error(`PeerConnection 连接失败：${peer.connectionState}。请重新生成并交换同一轮 Offer/Answer。`));
      }
    };
    const timer = window.setTimeout(() => {
      done(
        new Error(
          `DataChannel 没有打开。当前状态：peer=${peer.connectionState}，ice=${peer.iceConnectionState}，channel=${channel.readyState}。请重新生成并交换同一轮完整 Offer/Answer。`,
        ),
      );
    }, timeoutMs);
    channel.addEventListener("open", onOpen);
    channel.addEventListener("close", onClose);
    channel.addEventListener("error", onError);
    peer.addEventListener("iceconnectionstatechange", onIceState);
    peer.addEventListener("connectionstatechange", onPeerState);
  });
}

function waitForBuffer(channel: RTCDataChannel) {
  if (channel.bufferedAmount <= highWaterMark) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const previousThreshold = channel.bufferedAmountLowThreshold;
    const onLow = () => {
      channel.removeEventListener("bufferedamountlow", onLow);
      channel.bufferedAmountLowThreshold = previousThreshold;
      resolve();
    };
    channel.bufferedAmountLowThreshold = lowWaterMark;
    channel.addEventListener("bufferedamountlow", onLow);
  });
}

async function copyText(text: string) {
  if (!text) return;
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) {
    throw new Error("复制失败，请手动选中文本复制。");
  }
}

function saveBlob(file: ReceivedFile) {
  const anchor = document.createElement("a");
  anchor.href = file.url;
  anchor.download = file.name;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function TextArea({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="grid gap-2">
      <span className="text-sm font-extrabold text-[#233d64]">{label}</span>
      <textarea
        className="h-[clamp(88px,10.5dvh,118px)] min-h-0 resize-none rounded-xl border border-[#d7e5f6] bg-white px-3 py-3 font-mono text-[12px] leading-relaxed text-[#17345f] outline-none transition placeholder:text-[#91a4c0] focus:border-[#1677ff] focus:ring-4 focus:ring-[#1677ff]/10 max-[1180px]:h-[128px] max-[560px]:h-[116px]"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
      />
    </label>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled = false,
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      className="inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-[#1677ff] px-5 text-[15px] font-extrabold text-white shadow-[0_12px_22px_rgba(47,125,246,0.22)] transition hover:-translate-y-px hover:bg-[#0d63da] disabled:cursor-not-allowed disabled:bg-[#a9bdd8] disabled:shadow-none disabled:hover:translate-y-0"
      type={type}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function SecondaryButton({
  children,
  onClick,
  disabled = false,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-[#d7e5f6] bg-white px-4 text-[15px] font-extrabold text-[#17345f] transition hover:-translate-y-px hover:border-[#9ec7ff] disabled:cursor-not-allowed disabled:text-[#98a9c0] disabled:hover:translate-y-0"
      type="button"
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export default function DirectPage() {
  const senderPeerRef = useRef<RTCPeerConnection | null>(null);
  const receiverPeerRef = useRef<RTCPeerConnection | null>(null);
  const senderChannelRef = useRef<RTCDataChannel | null>(null);
  const receiverChannelRef = useRef<RTCDataChannel | null>(null);
  const receiveChunksRef = useRef<ArrayBuffer[]>([]);
  const receiveMetaRef = useRef<TransferMeta | null>(null);
  const receivedBytesRef = useRef(0);
  const receivedFilesRef = useRef<ReceivedFile[]>([]);
  const sendInFlightRef = useRef(false);
  const senderFileInputRef = useRef<HTMLInputElement | null>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [senderOffer, setSenderOffer] = useState("");
  const [senderAnswerInput, setSenderAnswerInput] = useState("");
  const [senderStatus, setSenderStatus] = useState("选择文件后生成 Offer。");
  const [senderError, setSenderError] = useState("");
  const [senderPeerState, setSenderPeerState] = useState("new");
  const [senderIceState, setSenderIceState] = useState("new");
  const [senderChannelState, setSenderChannelState] = useState("closed");
  const [senderProgress, setSenderProgress] = useState(0);
  const [sentBytes, setSentBytes] = useState(0);
  const [isSending, setIsSending] = useState(false);

  const [receiverOfferInput, setReceiverOfferInput] = useState("");
  const [receiverAnswer, setReceiverAnswer] = useState("");
  const [receiverStatus, setReceiverStatus] = useState("等待发送方 Offer。");
  const [receiverError, setReceiverError] = useState("");
  const [receiverPeerState, setReceiverPeerState] = useState("new");
  const [receiverIceState, setReceiverIceState] = useState("new");
  const [receiverChannelState, setReceiverChannelState] = useState("closed");
  const [receiverProgress, setReceiverProgress] = useState(0);
  const [receivedBytes, setReceivedBytes] = useState(0);
  const [incomingMeta, setIncomingMeta] = useState<TransferMeta | null>(null);
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const [transferMode, setTransferMode] = useState<TransferMode>(null);
  const [senderHandshakeStage, setSenderHandshakeStage] = useState<SenderHandshakeStage>("offer");

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

  const totalBytes = selectedFile?.size ?? incomingMeta?.size ?? 0;
  const progress = Math.max(senderProgress, receiverProgress);

  const transferSteps: TransferStep[] = [
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

  const details: DetailItem[] = [
    { label: "连接类型", value: "Direct DataChannel", icon: Link2 },
    {
      label: "发送端状态",
      value: `${senderPeerState} / ${senderIceState}`,
      icon: Circle,
      status: senderPeerState === "connected" ? "online" : undefined,
    },
    {
      label: "接收端状态",
      value: `${receiverPeerState} / ${receiverIceState}`,
      icon: Circle,
      status: receiverPeerState === "connected" ? "online" : undefined,
    },
    { label: "发送通道", value: senderChannelState, icon: Wifi },
    { label: "接收通道", value: receiverChannelState, icon: Wifi },
    { label: "选中文件", value: selectedFile ? selectedFile.name : "未选择", icon: HardDrive },
    { label: "文件大小", value: totalBytes ? formatBytes(totalBytes) : "0 B", icon: Database },
    { label: "已发送", value: formatBytes(sentBytes), icon: UploadCloud },
    { label: "已接收", value: formatBytes(receivedBytes), icon: Download },
    { label: "进度", value: formatPercent(progress), icon: Gauge, progress },
  ];

  const senderCanGenerateOffer = Boolean(selectedFile) && !isSending;
  const senderCanApplyAnswer = Boolean(senderAnswerInput.trim() && senderPeerRef.current);
  const receiverCanCreateAnswer = Boolean(receiverOfferInput.trim());

  const senderOfferSize = useMemo(() => (senderOffer ? `${senderOffer.length.toLocaleString()} 字符` : ""), [senderOffer]);
  const receiverAnswerSize = useMemo(() => (receiverAnswer ? `${receiverAnswer.length.toLocaleString()} 字符` : ""), [receiverAnswer]);

  function updateSenderPeerState(peer: RTCPeerConnection) {
    setSenderPeerState(peer.connectionState);
    setSenderIceState(peer.iceConnectionState);
  }

  function updateReceiverPeerState(peer: RTCPeerConnection) {
    setReceiverPeerState(peer.connectionState);
    setReceiverIceState(peer.iceConnectionState);
  }

  function closeSenderPeer() {
    senderChannelRef.current?.close();
    senderPeerRef.current?.close();
    senderChannelRef.current = null;
    senderPeerRef.current = null;
    setSenderPeerState("new");
    setSenderIceState("new");
    setSenderChannelState("closed");
  }

  function closeReceiverPeer() {
    receiverChannelRef.current?.close();
    receiverPeerRef.current?.close();
    receiverChannelRef.current = null;
    receiverPeerRef.current = null;
    receiveChunksRef.current = [];
    receiveMetaRef.current = null;
    receivedBytesRef.current = 0;
    setIncomingMeta(null);
    setReceiverPeerState("new");
    setReceiverIceState("new");
    setReceiverChannelState("closed");
  }

  function resetSender() {
    closeSenderPeer();
    setSenderOffer("");
    setSenderAnswerInput("");
    setSenderStatus("选择文件后生成 Offer。");
    setSenderError("");
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
    setReceiverStatus("等待发送方 Offer。");
    setReceiverError("");
    setReceiverProgress(0);
    setReceivedBytes(0);
  }

  function handleFile(file: File | null) {
    setSelectedFile(file);
    setSenderProgress(0);
    setSentBytes(0);
    if (file) {
      setSenderStatus(`已选择 ${file.name}，可以生成 Offer。`);
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

    try {
      setSenderError("");
      setSenderStatus("正在创建 WebRTC Offer，并收集本地 host 候选地址...");
      setSenderOffer("");
      setSenderAnswerInput("");
      setSenderProgress(0);
      setSentBytes(0);
      closeSenderPeer();

      const peer = createPeerConnection(updateSenderPeerState, setSenderError);
      const ice = collectIceCandidates(peer);
      senderPeerRef.current = peer;
      attachSenderChannel(peer.createDataChannel("file-transfer", { ordered: true }));

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGathering(peer);
      ice.stop();

      if (!peer.localDescription) {
        throw new Error("没有生成本地 Offer。");
      }
      assertHasCandidates(peer.localDescription, ice.candidates, "Offer");

      const encoded = await encodeSignal({
        kind: "direct-webrtc-signal",
        role: "offer",
        description: peer.localDescription.toJSON(),
        candidates: ice.candidates,
        createdAt: Date.now(),
      });
      setSenderOffer(encoded);
      setSenderHandshakeStage("offer");
      setSenderStatus(`完整 Offer 已生成，${formatCandidateSummary(peer.localDescription, ice.candidates)}。复制给接收方。`);
    } catch (error) {
      setSenderError(error instanceof Error ? error.message : "生成 Offer 失败。");
    }
  }

  async function createAnswerFromOffer() {
    try {
      setReceiverError("");
      setReceiverStatus("正在读取 Offer，并收集接收方 host 候选地址...");
      setReceiverAnswer("");
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

      const peer = createPeerConnection(updateReceiverPeerState, setReceiverError);
      const ice = collectIceCandidates(peer);
      receiverPeerRef.current = peer;
      peer.addEventListener("datachannel", (event) => attachReceiverChannel(event.channel));

      await peer.setRemoteDescription(payload.description);
      await addPayloadCandidates(peer, payload);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await waitForIceGathering(peer);
      ice.stop();

      if (!peer.localDescription) {
        throw new Error("没有生成本地 Answer。");
      }
      assertHasCandidates(peer.localDescription, ice.candidates, "Answer");

      const encoded = await encodeSignal({
        kind: "direct-webrtc-signal",
        role: "answer",
        description: peer.localDescription.toJSON(),
        candidates: ice.candidates,
        createdAt: Date.now(),
      });
      setReceiverAnswer(encoded);
      setReceiverStatus(`完整 Answer 已生成，${formatCandidateSummary(peer.localDescription, ice.candidates)}。复制给发送方。`);
    } catch (error) {
      setReceiverError(error instanceof Error ? error.message : "生成 Answer 失败。");
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

      setSenderStatus("正在应用 Answer，等待 DataChannel 打开...");
      await peer.setRemoteDescription(payload.description);
      await addPayloadCandidates(peer, payload);
      updateSenderPeerState(peer);
      const channel = senderChannelRef.current;
      if (!channel) {
        throw new Error("发送通道不存在，请重新生成 Offer。");
      }
      await waitForDataChannelOpen(channel, peer);
      await sendSelectedFile();
    } catch (error) {
      setSenderError(error instanceof Error ? error.message : "应用 Answer 失败。");
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
      while (offset < file.size) {
        const buffer = await file.slice(offset, offset + chunkSize).arrayBuffer();
        await waitForBuffer(channel);
        channel.send(buffer);
        offset += buffer.byteLength;
        setSentBytes(offset);
        setSenderProgress(file.size ? (offset / file.size) * 100 : 100);
      }

      const done: TransferDone = { kind: "done" };
      await waitForBuffer(channel);
      channel.send(JSON.stringify(done));
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
      setIncomingMeta(null);
      return;
    }

    setReceivedBytes(received);
    setReceiverProgress(size ? (received / size) * 100 : 0);
  }

  const senderConnected = senderChannelState === "open" || senderPeerState === "connected";
  const receiverConnected = receiverChannelState === "open" || receiverPeerState === "connected";
  const activeConnected = transferMode === "send" ? senderConnected : transferMode === "receive" ? receiverConnected : false;

  function RoleOption({
    mode,
    title,
    description,
    icon: Icon,
  }: {
    mode: Exclude<TransferMode, null>;
    title: string;
    description: string;
    icon: typeof Monitor;
  }) {
    const selected = transferMode === mode;
    return (
      <button
        className={`grid min-h-[68px] grid-cols-[22px_34px_minmax(0,1fr)] items-center gap-3 rounded-xl border px-3 text-left transition hover:-translate-y-px hover:border-[#1677ff] hover:bg-white ${
          selected ? "border-[#9ec7ff] bg-[#f2f8ff] shadow-[0_8px_22px_rgba(47,125,246,0.10)]" : "border-[#d7e5f6] bg-white/80"
        }`}
        type="button"
        onClick={() => {
          setTransferMode(mode);
          if (mode === "send") {
            setSenderHandshakeStage(senderOffer ? "answer" : "offer");
          }
        }}
      >
        <span className={`size-4 rounded-full border ${selected ? "border-[#1677ff] bg-[#1677ff] ring-4 ring-[#1677ff]/15" : "border-[#9aabc4]"}`} />
        <Icon aria-hidden="true" className={selected ? "text-[#1677ff]" : "text-[#6e82a0]"} size={23} />
        <span className="min-w-0">
          <strong className="block text-[15px] font-extrabold text-[#071b3a]">{title}</strong>
          <span className="block truncate text-[13px] text-[#526c92]">{description}</span>
        </span>
      </button>
    );
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(340px,0.92fr)_minmax(0,1.85fr)] grid-rows-[auto_minmax(180px,0.5fr)] gap-[clamp(12px,1.2vw,18px)] max-[1180px]:grid-cols-1 max-[1180px]:grid-rows-none max-[1180px]:gap-[clamp(14px,1.5vw,22px)]">
        <Panel className="row-span-2 flex min-h-0 flex-col overflow-hidden p-[clamp(16px,1.45vw,22px)] max-[1180px]:row-span-1 max-[1180px]:overflow-visible max-[1180px]:p-[clamp(18px,1.8vw,28px)]">
          <div className="mb-5 flex shrink-0 items-start justify-between gap-4">
            <div>
              <h2 className="text-[22px] font-extrabold text-[#061b3a]">连接状态</h2>
              <p className="mt-1 text-[15px] text-[#526c92]">手动复制 Offer / Answer，文件走 DataChannel 点对点传输。</p>
            </div>
            <SecondaryButton
              onClick={() => {
                resetSender();
                resetReceiver();
                setTransferMode(null);
              }}
            >
              <RefreshCw aria-hidden="true" size={17} />
              重置
            </SecondaryButton>
          </div>

          <div className="relative grid shrink-0 grid-cols-4 items-start max-[620px]:grid-cols-1 max-[620px]:gap-5">
            <div className="absolute left-[12.5%] right-[12.5%] top-[26px] grid grid-cols-3 max-[620px]:hidden">
              {transferSteps.slice(0, -1).map((step) => (
                <span
                  className={`mx-7 h-[3px] rounded-full ${step.active ? "bg-[#1677ff]" : "bg-[#cdd8e7]"}`}
                  key={`connector-${step.label}`}
                />
              ))}
            </div>
            {transferSteps.map((step) => {
              const Icon = step.icon;
              return (
                <div className="relative z-10 grid min-w-0 justify-items-center text-center max-[620px]:grid-cols-[56px_1fr] max-[620px]:justify-items-start max-[620px]:gap-3 max-[620px]:text-left" key={step.label}>
                    <span
                      className={`grid size-[54px] place-items-center rounded-2xl text-white shadow-[0_10px_25px_rgba(47,125,246,0.25)] ${
                        step.active ? "bg-[#1677ff]" : "bg-[#aeb8c8]"
                      }`}
                    >
                      <Icon aria-hidden="true" size={25} />
                    </span>
                    <div className="min-w-0">
                      <strong className="mt-4 block truncate text-[15px] font-extrabold text-[#071b3a] max-[620px]:mt-1">
                        {step.label}
                      </strong>
                      <span className="mt-2 block truncate text-sm text-[#667a9a] max-[620px]:mt-0">{step.meta}</span>
                    </div>
                </div>
              );
            })}
          </div>

          <div className="my-5 h-px shrink-0 bg-[#e3edf9]" />

          <h2 className="mb-3 shrink-0 text-[22px] font-extrabold text-[#061b3a]">连接详情</h2>
          <div className="grid shrink-0 grid-cols-2 gap-2.5 max-[560px]:grid-cols-1">
            {details.map((item) => {
              const Icon = item.icon;
              return (
                <div
                  className="grid min-h-[62px] grid-cols-[30px_minmax(0,1fr)] items-center gap-2.5 rounded-xl border border-[#dfeaf7] bg-white/65 px-3 py-2.5 text-[13px] shadow-[0_6px_16px_rgba(16,34,59,0.025)]"
                  key={item.label}
                >
                  <span className="grid size-[30px] place-items-center rounded-lg bg-[#eef6ff] text-[#1677ff]">
                    <Icon aria-hidden="true" size={16} />
                  </span>
                  {item.progress == null ? (
                    <span className="min-w-0">
                      <span className="block whitespace-nowrap text-[#6a7f9e]">{item.label}</span>
                      <strong className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[14px] font-extrabold text-[#142a4f]">
                        {item.status === "online" && <span className="inline-block size-2 shrink-0 rounded-full bg-[#1dc85f]" />}
                        <span className="min-w-0 truncate">{item.value}</span>
                      </strong>
                    </span>
                  ) : (
                    <span className="grid min-w-0 gap-1.5">
                      <span className="flex items-center justify-between gap-2">
                        <span className="whitespace-nowrap text-[#6a7f9e]">{item.label}</span>
                        <strong className="text-[14px] font-extrabold text-[#142a4f]">{item.value}</strong>
                      </span>
                      <span className="h-1.5 rounded-full bg-[#dce8f7]">
                        <span className="block h-full rounded-full bg-[#1677ff]" style={{ width: `${item.progress}%` }} />
                      </span>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </Panel>

        <div className="grid min-h-0 grid-cols-2 gap-[clamp(12px,1.2vw,18px)] max-[980px]:grid-cols-1 max-[980px]:gap-[clamp(14px,1.5vw,22px)]">
          <Panel className="min-h-0 overflow-visible p-[clamp(16px,1.45vw,22px)] max-[1180px]:p-[clamp(18px,1.8vw,28px)]">
            <div className="mb-4">
              <h2 className="text-[22px] font-extrabold text-[#061b3a]">选择传输目标</h2>
              <p className="mt-1 text-[15px] text-[#526c92]">先选择当前网页要负责发送还是接收。</p>
            </div>

            {!transferMode && (
              <div className="grid gap-3">
                <RoleOption mode="send" title="发送文件" description="生成 Offer，等待接收方 Answer" icon={UploadCloud} />
                <RoleOption mode="receive" title="接收文件" description="粘贴 Offer，生成 Answer" icon={Download} />
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
                    {transferMode === "send" ? "Answer 已应用，文件会通过 DataChannel 发送。" : "接收通道已打开，等待发送方传输文件。"}
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
                    <TextArea label={`发送方 Offer ${senderOfferSize}`} value={senderOffer} onChange={setSenderOffer} placeholder="选择文件并生成 Offer 后，把这一整串文本复制给接收方" />
                    <div className="flex flex-wrap gap-3">
                      <PrimaryButton onClick={generateOffer} disabled={!senderCanGenerateOffer}>
                        <Send aria-hidden="true" size={17} />
                        生成 Offer
                      </PrimaryButton>
                      <SecondaryButton onClick={() => void copySenderOffer()} disabled={!senderOffer}>
                        <Copy aria-hidden="true" size={17} />
                        复制 Offer
                      </SecondaryButton>
                    </div>
                  </>
                ) : (
                  <>
                    <TextArea label="接收方 Answer" value={senderAnswerInput} onChange={setSenderAnswerInput} placeholder="把接收方生成的 Answer 粘贴到这里" />
                    <div className="flex flex-wrap gap-3">
                      <SecondaryButton onClick={() => setSenderHandshakeStage("offer")}>
                        <FileText aria-hidden="true" size={17} />
                        查看 Offer
                      </SecondaryButton>
                      <PrimaryButton onClick={applyAnswerToSender} disabled={!senderCanApplyAnswer}>
                        <Link2 aria-hidden="true" size={17} />
                        发送
                      </PrimaryButton>
                    </div>
                  </>
                )}
                <p className={`rounded-xl px-4 py-3 text-[14px] ${senderError ? "bg-[#fff0f0] text-[#b4232b]" : "bg-[#edf6ff] text-[#365a88]"}`}>
                  {senderError || senderStatus}
                </p>
              </div>
            )}

            {transferMode === "receive" && !activeConnected && (
              <div className="grid gap-4">
                {receiverAnswer ? (
                  <>
                    <TextArea label={`接收方 Answer ${receiverAnswerSize}`} value={receiverAnswer} onChange={setReceiverAnswer} placeholder="生成后复制这一整串文本给发送方" />
                    <div className="flex flex-wrap gap-3">
                      <SecondaryButton onClick={() => setReceiverAnswer("")}>
                        <FileText aria-hidden="true" size={17} />
                        修改 Offer
                      </SecondaryButton>
                      <PrimaryButton onClick={() => void copyReceiverAnswer()} disabled={!receiverAnswer}>
                        <Copy aria-hidden="true" size={17} />
                        复制 Answer
                      </PrimaryButton>
                    </div>
                  </>
                ) : (
                  <>
                    <TextArea label="发送方 Offer" value={receiverOfferInput} onChange={setReceiverOfferInput} placeholder="把发送方 Offer 粘贴到这里" />
                    <div className="flex flex-wrap gap-3">
                      <PrimaryButton onClick={createAnswerFromOffer} disabled={!receiverCanCreateAnswer}>
                        <Link2 aria-hidden="true" size={17} />
                        生成 Answer
                      </PrimaryButton>
                    </div>
                  </>
                )}
                <p className={`rounded-xl px-4 py-3 text-[14px] ${receiverError ? "bg-[#fff0f0] text-[#b4232b]" : "bg-[#edf6ff] text-[#365a88]"}`}>
                  {receiverError || receiverStatus}
                </p>
              </div>
            )}
          </Panel>

          <Panel className="min-h-0 overflow-hidden p-[clamp(16px,1.45vw,22px)] max-[1180px]:overflow-visible max-[1180px]:p-[clamp(18px,1.8vw,28px)]">
            <div
              className="grid h-full min-h-[220px] place-items-center rounded-2xl border-2 border-dashed border-[#bdd3f1] bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(244,249,255,0.78))] px-5 py-5 text-center max-[1180px]:min-h-[300px] max-[1180px]:py-7"
              onDrop={handleDrop}
              onDragOver={(event) => event.preventDefault()}
              aria-label="选择发送文件"
            >
              <input ref={senderFileInputRef} className="hidden" type="file" onChange={handleFileInput} />
              <div className="mb-4 grid size-[clamp(64px,7.5dvh,82px)] place-items-center rounded-3xl bg-[#1677ff] text-white shadow-[0_16px_32px_rgba(47,125,246,0.28)] max-[1180px]:size-[82px]">
                <UploadCloud aria-hidden="true" size={46} />
              </div>
              <strong
                className="block h-[30px] w-full max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[20px] font-extrabold leading-[30px] text-[#071b3a]"
                title={selectedFile?.name}
              >
                {selectedFile ? selectedFile.name : "点击或拖拽文件到此处上传"}
              </strong>
              <span className="mt-1 text-[14px] text-[#526c92]">{selectedFile ? formatBytes(selectedFile.size) : "选择发送文件后再生成 Offer"}</span>
              <div className="mt-5 flex flex-wrap justify-center gap-3">
                <PrimaryButton onClick={() => senderFileInputRef.current?.click()}>
                  <HardDrive aria-hidden="true" size={17} />
                  选择文件
                </PrimaryButton>
              </div>
            </div>
          </Panel>
        </div>

        <Panel className="flex min-h-0 flex-col overflow-hidden p-[clamp(16px,1.45vw,22px)] max-[1180px]:overflow-visible max-[1180px]:p-[clamp(18px,1.8vw,28px)]">
          <div className="mb-4 flex shrink-0 items-center justify-between gap-4 max-[560px]:items-start max-[560px]:flex-col">
            <h2 className="m-0 text-[26px] font-extrabold text-[#061b3a]">已接收文件</h2>
            <span className="rounded-lg border border-[#d7e5f6] bg-white px-4 py-2 text-[15px] font-medium text-[#526c92]">
              {receivedFiles.length} 个文件
            </span>
          </div>

          <div
            className={`grid min-h-0 gap-3 ${receivedFiles.length > 0 ? "overflow-auto pr-1" : "overflow-hidden"}`}
            role="table"
            aria-label="已接收文件列表"
          >
            {receivedFiles.length === 0 ? (
              <div className="grid min-h-[108px] place-items-center rounded-xl border border-dashed border-[#c7daf2] bg-white/70 text-[15px] text-[#607a9f]">
                接收完成后，文件会出现在这里并自动触发下载。
              </div>
            ) : (
              receivedFiles.map((file) => (
                <article
                  className="grid min-h-[72px] grid-cols-[minmax(180px,1.8fr)_minmax(92px,0.55fr)_minmax(170px,0.9fr)_minmax(124px,0.5fr)] items-center gap-4 rounded-xl border border-[#e0eaf7] bg-white px-4 text-[15px] text-[#355176] shadow-[0_8px_22px_rgba(16,34,59,0.035)] max-[900px]:grid-cols-1 max-[900px]:gap-2.5 max-[900px]:p-4"
                  key={file.id}
                  role="row"
                >
                  <div className="flex min-w-0 items-center gap-3 text-[#071b3a]" role="cell">
                    <span className="grid size-8 shrink-0 place-items-center rounded-md bg-[#20c263] text-white shadow-sm">
                      <FileText aria-hidden="true" size={17} />
                    </span>
                    <strong className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[16px] font-extrabold">{file.name}</strong>
                  </div>
                  <span role="cell">{formatBytes(file.size)}</span>
                  <time role="cell">{file.receivedAt}</time>
                  <button
                    className="inline-flex min-h-[34px] items-center justify-center gap-1.5 rounded-lg border border-[#d7e5f6] bg-white px-3 text-[15px] font-extrabold text-[#1677ff] transition hover:border-[#9ec7ff]"
                    type="button"
                    onClick={() => saveBlob(file)}
                  >
                    <Download aria-hidden="true" size={17} />
                    下载
                  </button>
                </article>
              ))
            )}
          </div>
        </Panel>
    </div>
  );
}
