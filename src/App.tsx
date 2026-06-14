import {
  Check,
  Circle,
  Cloud,
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

type SignalPayload = {
  kind: "direct-webrtc-signal";
  role: "offer" | "answer";
  description: RTCSessionDescriptionInit;
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

const navItems = ["Direct", "STUN", "TURN", "SFU", "R2"];
const rtcConfig: RTCConfiguration = { iceServers: [] };
const chunkSize = 64 * 1024;
const highWaterMark = 8 * 1024 * 1024;
const lowWaterMark = 2 * 1024 * 1024;
const iceGatheringTimeoutMs = 30000;
const channelOpenTimeoutMs = 18000;

function Panel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-white/70 bg-white/90 shadow-[0_18px_55px_rgba(23,54,97,0.10)] ring-1 ring-[#d9e7f8]/70 backdrop-blur ${className}`}
    >
      {children}
    </section>
  );
}

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

function summarizeCandidates(description: RTCSessionDescriptionInit | null) {
  const sdp = description?.sdp ?? "";
  const summary = { host: 0, srflx: 0, relay: 0, total: 0 };
  const candidates = sdp.match(/^a=candidate:.*$/gm) ?? [];
  for (const candidate of candidates) {
    summary.total += 1;
    if (/\styp host(\s|$)/.test(candidate)) summary.host += 1;
    if (/\styp srflx(\s|$)/.test(candidate)) summary.srflx += 1;
    if (/\styp relay(\s|$)/.test(candidate)) summary.relay += 1;
  }
  return summary;
}

function formatCandidateSummary(description: RTCSessionDescriptionInit | null) {
  const summary = summarizeCandidates(description);
  if (summary.total === 0) return "未收集到候选地址";
  return `${summary.total} 个候选地址，host ${summary.host}，srflx ${summary.srflx}，relay ${summary.relay}`;
}

function assertHasCandidates(description: RTCSessionDescriptionInit | null, label: string) {
  const summary = summarizeCandidates(description);
  if (summary.total === 0) {
    throw new Error(`${label} 没有包含 ICE candidate，请刷新页面后重新生成。`);
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
        className="min-h-[132px] resize-y rounded-xl border border-[#d7e5f6] bg-white px-3 py-3 font-mono text-[12px] leading-relaxed text-[#17345f] outline-none transition placeholder:text-[#91a4c0] focus:border-[#1677ff] focus:ring-4 focus:ring-[#1677ff]/10"
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
      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#1677ff] px-5 text-[15px] font-extrabold text-white shadow-[0_12px_22px_rgba(47,125,246,0.22)] transition hover:-translate-y-px hover:bg-[#0d63da] disabled:cursor-not-allowed disabled:bg-[#a9bdd8] disabled:shadow-none disabled:hover:translate-y-0"
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
      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[#d7e5f6] bg-white px-4 text-[15px] font-extrabold text-[#17345f] transition hover:-translate-y-px hover:border-[#9ec7ff] disabled:cursor-not-allowed disabled:text-[#98a9c0] disabled:hover:translate-y-0"
      type="button"
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export default function App() {
  const senderPeerRef = useRef<RTCPeerConnection | null>(null);
  const receiverPeerRef = useRef<RTCPeerConnection | null>(null);
  const senderChannelRef = useRef<RTCDataChannel | null>(null);
  const receiverChannelRef = useRef<RTCDataChannel | null>(null);
  const receiveChunksRef = useRef<ArrayBuffer[]>([]);
  const receiveMetaRef = useRef<TransferMeta | null>(null);
  const receivedBytesRef = useRef(0);
  const receivedFilesRef = useRef<ReceivedFile[]>([]);
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
    { label: "连接类型", value: "Direct WebRTC DataChannel", icon: Link2 },
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
      setSenderStatus("DataChannel 已打开，开始发送文件。");
      void sendSelectedFile();
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
      senderPeerRef.current = peer;
      attachSenderChannel(peer.createDataChannel("file-transfer", { ordered: true }));

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGathering(peer);

      if (!peer.localDescription) {
        throw new Error("没有生成本地 Offer。");
      }
      assertHasCandidates(peer.localDescription, "Offer");

      const encoded = await encodeSignal({
        kind: "direct-webrtc-signal",
        role: "offer",
        description: peer.localDescription.toJSON(),
        createdAt: Date.now(),
      });
      setSenderOffer(encoded);
      setSenderStatus(`完整 Offer 已生成，${formatCandidateSummary(peer.localDescription)}。复制给接收方。`);
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
      receiverPeerRef.current = peer;
      peer.addEventListener("datachannel", (event) => attachReceiverChannel(event.channel));

      await peer.setRemoteDescription(payload.description);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await waitForIceGathering(peer);

      if (!peer.localDescription) {
        throw new Error("没有生成本地 Answer。");
      }
      assertHasCandidates(peer.localDescription, "Answer");

      const encoded = await encodeSignal({
        kind: "direct-webrtc-signal",
        role: "answer",
        description: peer.localDescription.toJSON(),
        createdAt: Date.now(),
      });
      setReceiverAnswer(encoded);
      setReceiverStatus(`完整 Answer 已生成，${formatCandidateSummary(peer.localDescription)}。复制给发送方。`);
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

  async function sendSelectedFile() {
    const file = selectedFile;
    const channel = senderChannelRef.current;
    if (!file || !channel || channel.readyState !== "open" || isSending || senderProgress >= 100) return;

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
      setIsSending(false);
    }
  }

  async function handleReceiverMessage(data: unknown) {
    if (typeof data === "string") {
      const message = JSON.parse(data) as TransferMeta | TransferDone;
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
        if (!meta) throw new Error("缺少文件元数据。");

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

    const buffer = data instanceof ArrayBuffer ? data : await (data as Blob).arrayBuffer();
    receiveChunksRef.current.push(buffer);
    receivedBytesRef.current += buffer.byteLength;
    const received = receivedBytesRef.current;
    const size = receiveMetaRef.current?.size ?? 0;
    setReceivedBytes(received);
    setReceiverProgress(size ? (received / size) * 100 : 0);
  }

  return (
    <main className="mx-auto flex min-h-dvh w-[min(1680px,calc(100vw_-_clamp(28px,4vw,72px)))] flex-col py-[clamp(18px,2.5vw,34px)]">
      <header className="mb-[clamp(18px,2.2vw,28px)] grid grid-cols-[minmax(210px,260px)_minmax(0,1fr)_minmax(160px,260px)] items-center gap-4 max-[1040px]:grid-cols-1 max-[1040px]:justify-items-center">
        <a
          className="inline-flex w-fit items-center gap-3 text-[22px] font-extrabold text-[#071b3a] max-[560px]:text-lg"
          href="/"
          aria-label="文件中转站首页"
        >
          <span className="grid size-11 place-items-center rounded-2xl bg-[#1677ff] text-white shadow-[0_12px_28px_rgba(47,125,246,0.34)]">
            <Cloud aria-hidden="true" size={26} />
          </span>
          <strong>文件中转站</strong>
        </a>

        <nav
          className="mx-auto flex max-w-full items-center gap-2 overflow-x-auto rounded-2xl border border-white/70 bg-white/70 p-1.5 text-[16px] font-extrabold text-[#344a68] shadow-[0_14px_38px_rgba(23,54,97,0.08)] backdrop-blur max-[700px]:w-full max-[700px]:justify-between max-[560px]:text-sm"
          aria-label="功能导航"
        >
          {navItems.map((item) => (
            <a
              className={
                item === "Direct"
                  ? "inline-flex min-w-[118px] items-center justify-center rounded-xl bg-[#1677ff] px-7 py-3 text-white shadow-[0_10px_26px_rgba(47,125,246,0.22)] max-[700px]:min-w-0 max-[700px]:px-4 max-[700px]:py-2.5"
                  : "inline-flex items-center justify-center rounded-xl px-6 py-3 transition hover:bg-white hover:text-[#1476ff] max-[700px]:px-3 max-[700px]:py-2.5"
              }
              href={`#${item.toLowerCase()}`}
              key={item}
            >
              {item}
            </a>
          ))}
        </nav>
      </header>

      <div className="grid flex-1 grid-cols-[minmax(360px,1fr)_minmax(0,1.8fr)] gap-[clamp(14px,1.5vw,22px)] max-[1180px]:grid-cols-1">
        <Panel className="p-[clamp(18px,1.8vw,28px)]">
          <div className="mb-7 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-[22px] font-extrabold text-[#061b3a]">连接状态</h2>
              <p className="mt-1 text-[15px] text-[#526c92]">手动复制 Offer / Answer，文件走 DataChannel 点对点传输。</p>
            </div>
            <SecondaryButton
              onClick={() => {
                resetSender();
                resetReceiver();
              }}
            >
              <RefreshCw aria-hidden="true" size={17} />
              重置
            </SecondaryButton>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_minmax(22px,40px)_minmax(0,1fr)_minmax(22px,40px)_minmax(0,1fr)_minmax(22px,40px)_minmax(0,1fr)] items-start gap-2 max-[620px]:grid-cols-1 max-[620px]:gap-5">
            {transferSteps.map((step, index) => {
              const Icon = step.icon;
              return (
                <div className="contents max-[620px]:block" key={step.label}>
                  <div className="grid justify-items-center text-center max-[620px]:grid-cols-[56px_1fr] max-[620px]:justify-items-start max-[620px]:gap-3 max-[620px]:text-left">
                    <span
                      className={`grid size-[54px] place-items-center rounded-2xl text-white shadow-[0_10px_25px_rgba(47,125,246,0.25)] ${
                        step.active ? "bg-[#1677ff]" : "bg-[#aeb8c8]"
                      }`}
                    >
                      <Icon aria-hidden="true" size={25} />
                    </span>
                    <div>
                      <strong className="mt-4 block text-[15px] font-extrabold text-[#071b3a] max-[620px]:mt-1">
                        {step.label}
                      </strong>
                      <span className="mt-2 block text-sm text-[#667a9a] max-[620px]:mt-0">{step.meta}</span>
                    </div>
                  </div>
                  {index < transferSteps.length - 1 && (
                    <span className={`mt-[25px] h-[3px] rounded-full max-[620px]:hidden ${step.active ? "bg-[#1677ff]" : "bg-[#cdd8e7]"}`} />
                  )}
                </div>
              );
            })}
          </div>

          <div className="my-7 h-px bg-[#e3edf9]" />

          <h2 className="mb-4 text-[22px] font-extrabold text-[#061b3a]">连接详情</h2>
          <div className="grid gap-0">
            {details.map((item) => {
              const Icon = item.icon;
              return (
                <div
                  className="grid min-h-[38px] grid-cols-[24px_minmax(0,1fr)_minmax(0,max-content)] items-center gap-3 border-b border-[#e5edf8] text-[15px] last:border-b-0 max-[560px]:grid-cols-[24px_1fr] max-[560px]:py-2"
                  key={item.label}
                >
                  <Icon aria-hidden="true" className="text-[#526c92]" size={18} />
                  <span className="text-[#526c92]">{item.label}</span>
                  {item.progress == null ? (
                    <span className="min-w-0 justify-self-end break-words text-right font-medium text-[#142a4f] max-[560px]:col-span-2 max-[560px]:justify-self-start max-[560px]:text-left">
                      {item.status === "online" && <span className="mr-2 inline-block size-2.5 rounded-full bg-[#1dc85f]" />}
                      {item.value}
                    </span>
                  ) : (
                    <span className="grid w-[min(420px,42vw)] max-w-full grid-cols-[minmax(0,1fr)_58px] items-center gap-5 max-[1180px]:w-[min(420px,70vw)] max-[560px]:col-span-2 max-[560px]:w-full">
                      <span className="h-1 rounded-full bg-[#cdd8e7]">
                        <span className="block h-full rounded-full bg-[#1677ff]" style={{ width: `${item.progress}%` }} />
                      </span>
                      <span className="text-right font-medium text-[#142a4f]">{item.value}</span>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </Panel>

        <div className="grid grid-cols-2 gap-[clamp(14px,1.5vw,22px)] max-[980px]:grid-cols-1">
          <Panel className="p-[clamp(18px,1.8vw,28px)]">
            <div className="mb-5">
              <h2 className="text-[22px] font-extrabold text-[#061b3a]">发送方</h2>
              <p className="mt-1 text-[15px] text-[#526c92]">选择文件，复制 Offer；收到 Answer 后粘贴回来。</p>
            </div>

            <div
              className="grid min-h-[210px] place-items-center rounded-2xl border-2 border-dashed border-[#bdd3f1] bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(244,249,255,0.78))] px-5 py-7 text-center"
              onDrop={handleDrop}
              onDragOver={(event) => event.preventDefault()}
              aria-label="选择发送文件"
            >
              <input ref={senderFileInputRef} className="hidden" type="file" onChange={handleFileInput} />
              <div className="mb-5 grid size-[74px] place-items-center rounded-3xl bg-[#1677ff] text-white shadow-[0_16px_32px_rgba(47,125,246,0.28)]">
                <UploadCloud aria-hidden="true" size={44} />
              </div>
              <strong className="max-w-full break-words text-[20px] font-extrabold text-[#071b3a]">
                {selectedFile ? selectedFile.name : "点击或拖拽文件到此处"}
              </strong>
              <span className="mt-1 text-[14px] text-[#526c92]">{selectedFile ? formatBytes(selectedFile.size) : "DataChannel 分块发送"}</span>
              <div className="mt-5 flex flex-wrap justify-center gap-3">
                <SecondaryButton onClick={() => senderFileInputRef.current?.click()}>
                  <HardDrive aria-hidden="true" size={17} />
                  选择文件
                </SecondaryButton>
                <PrimaryButton onClick={generateOffer} disabled={!senderCanGenerateOffer}>
                  <Send aria-hidden="true" size={17} />
                  生成 Offer
                </PrimaryButton>
              </div>
            </div>

            <div className="mt-5 grid gap-4">
              <TextArea label={`发送方 Offer ${senderOfferSize}`} value={senderOffer} onChange={setSenderOffer} placeholder="生成后复制这一整串文本给接收方" />
              <div className="flex flex-wrap gap-3">
                <SecondaryButton onClick={() => void copyText(senderOffer)} disabled={!senderOffer}>
                  <Copy aria-hidden="true" size={17} />
                  复制 Offer
                </SecondaryButton>
              </div>

              <TextArea label="接收方 Answer" value={senderAnswerInput} onChange={setSenderAnswerInput} placeholder="把接收方生成的 Answer 粘贴到这里" />
              <PrimaryButton onClick={applyAnswerToSender} disabled={!senderCanApplyAnswer}>
                <Link2 aria-hidden="true" size={17} />
                应用 Answer 并发送
              </PrimaryButton>
            </div>

            <p className={`mt-4 rounded-xl px-4 py-3 text-[14px] ${senderError ? "bg-[#fff0f0] text-[#b4232b]" : "bg-[#edf6ff] text-[#365a88]"}`}>
              {senderError || senderStatus}
            </p>
          </Panel>

          <Panel className="p-[clamp(18px,1.8vw,28px)]">
            <div className="mb-5">
              <h2 className="text-[22px] font-extrabold text-[#061b3a]">接收方</h2>
              <p className="mt-1 text-[15px] text-[#526c92]">粘贴 Offer，复制 Answer；连接打开后自动下载收到的文件。</p>
            </div>

            <div className="grid gap-4">
              <TextArea label="发送方 Offer" value={receiverOfferInput} onChange={setReceiverOfferInput} placeholder="把发送方 Offer 粘贴到这里" />
              <PrimaryButton onClick={createAnswerFromOffer} disabled={!receiverCanCreateAnswer}>
                <Link2 aria-hidden="true" size={17} />
                生成 Answer
              </PrimaryButton>

              <TextArea label={`接收方 Answer ${receiverAnswerSize}`} value={receiverAnswer} onChange={setReceiverAnswer} placeholder="生成后复制这一整串文本给发送方" />
              <div className="flex flex-wrap gap-3">
                <SecondaryButton onClick={() => void copyText(receiverAnswer)} disabled={!receiverAnswer}>
                  <Copy aria-hidden="true" size={17} />
                  复制 Answer
                </SecondaryButton>
              </div>
            </div>

            <div className="mt-5 rounded-2xl border border-[#d7e5f6] bg-white px-4 py-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="text-[17px] font-extrabold text-[#071b3a]">接收文件</h3>
                <span className="text-[14px] font-medium text-[#526c92]">{incomingMeta ? incomingMeta.name : "空闲"}</span>
              </div>
              <div className="h-2 rounded-full bg-[#dce8f7]">
                <span className="block h-full rounded-full bg-[#1677ff]" style={{ width: `${receiverProgress}%` }} />
              </div>
              <div className="mt-3 flex justify-between gap-3 text-[14px] text-[#526c92]">
                <span>{formatBytes(receivedBytes)}</span>
                <span>{incomingMeta ? formatBytes(incomingMeta.size) : "0 B"}</span>
              </div>
            </div>

            <p className={`mt-4 rounded-xl px-4 py-3 text-[14px] ${receiverError ? "bg-[#fff0f0] text-[#b4232b]" : "bg-[#edf6ff] text-[#365a88]"}`}>
              {receiverError || receiverStatus}
            </p>
          </Panel>
        </div>

        <Panel className="col-span-2 p-[clamp(18px,1.8vw,28px)] max-[1180px]:col-span-1">
          <div className="mb-6 flex items-center justify-between gap-4 max-[560px]:items-start max-[560px]:flex-col">
            <h2 className="m-0 text-[26px] font-extrabold text-[#061b3a]">已接收文件</h2>
            <span className="rounded-lg border border-[#d7e5f6] bg-white px-4 py-2 text-[15px] font-medium text-[#526c92]">
              {receivedFiles.length} 个文件
            </span>
          </div>

          <div className="grid gap-3" role="table" aria-label="已接收文件列表">
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
    </main>
  );
}
