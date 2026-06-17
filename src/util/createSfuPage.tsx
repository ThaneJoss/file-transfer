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
  RefreshCw,
  Send,
  Server,
  UploadCloud,
  Wifi,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";

import { PrimaryButton, SecondaryButton, StatusMessage, TextArea, TextInput } from "../component/TransferControls";
import {
  ActionPanel,
  FilePickerPanel,
  FilesPanel,
  MainPanelGrid,
  MetricGrid,
  ReceivedFilesPanel,
  RoleOption,
  StatusPanel,
  TransferPageGrid,
  TransferSteps,
  UploadPanel,
} from "../layout/TransferLayout";
import type { MetricItem, TransferStepItem } from "../layout/TransferLayout";

type Credentials = {
  appId: string;
  appToken: string;
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

type SfuConnectionCode = {
  kind: "cloudflare-sfu-file-v1";
  publisherSessionId: string;
  dataChannelName: string;
  file: Omit<TransferMeta, "kind">;
  createdAt: number;
};

type CallsSession = {
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

type CallsApiResponse = {
  errorCode?: string;
  errorDescription?: string;
  sessionId?: string;
  sessionDescription?: RTCSessionDescriptionInit;
  requiresImmediateRenegotiation?: boolean;
  dataChannel?: DataChannelObject;
  dataChannels?: DataChannelObject[];
  datachannels?: DataChannelObject[];
};

type ReceivedFile = {
  id: string;
  name: string;
  size: number;
  type: string;
  url: string;
  receivedAt: string;
};

type Mode = "send" | "receive" | null;

const apiOrigin = "https://rtc.live.cloudflare.com/v1";
const chunkSize = 256 * 1024;
const highWaterMark = 16 * 1024 * 1024;
const lowWaterMark = 4 * 1024 * 1024;
const progressUpdateIntervalMs = 100;
const channelOpenTimeoutMs = 30000;

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function formatPercent(value: number) {
  return `${Math.max(0, Math.min(100, value)).toFixed(0)}%`;
}

function createStableId() {
  const randomUUID = (globalThis.crypto as (Crypto & { randomUUID?: () => string }) | undefined)?.randomUUID;
  if (randomUUID) return randomUUID.call(globalThis.crypto);

  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
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

async function encodeConnectionCode(payload: SfuConnectionCode) {
  const json = JSON.stringify(payload);
  const compression = globalThis.CompressionStream;
  if (!compression) {
    return `J1.${bytesToBase64Url(new TextEncoder().encode(json))}`;
  }

  const stream = new Blob([json]).stream().pipeThrough(new compression("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return `D1.${bytesToBase64Url(new Uint8Array(buffer))}`;
}

async function decodeConnectionCode(value: string): Promise<SfuConnectionCode> {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("请先粘贴 SFU 连接码。");

  let json: string;
  if (trimmed.startsWith("J1.")) {
    json = new TextDecoder().decode(base64UrlToBytes(trimmed.slice(3)));
  } else if (trimmed.startsWith("D1.")) {
    const decompression = globalThis.DecompressionStream;
    if (!decompression) {
      throw new Error("当前浏览器不能解压 D1 连接码，请换用最新版 Chrome、Edge 或 Safari。");
    }
    const bytes = base64UrlToBytes(trimmed.slice(3));
    const stream = new Blob([bytes]).stream().pipeThrough(new decompression("gzip"));
    json = await new Response(stream).text();
  } else {
    json = trimmed;
  }

  const payload = JSON.parse(json) as SfuConnectionCode;
  if (
    payload.kind !== "cloudflare-sfu-file-v1" ||
    !payload.publisherSessionId ||
    !payload.dataChannelName ||
    !payload.file?.name ||
    typeof payload.file.size !== "number"
  ) {
    throw new Error("SFU 连接码格式不正确。");
  }
  return payload;
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
  if (!copied) throw new Error("复制失败，请手动选中文本复制。");
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

function validateCredentials({ appId, appToken }: Credentials) {
  if (!appId.trim() || !appToken.trim()) {
    throw new Error("请填写 Cloudflare Realtime App ID 和 App Token。");
  }
}

async function callsFetch(credentials: Credentials, path: string, init: RequestInit = {}) {
  validateCredentials(credentials);
  const response = await fetch(`${apiOrigin}/apps/${encodeURIComponent(credentials.appId.trim())}${path}`, {
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

function createPeerConnection(onState: (peer: RTCPeerConnection) => void) {
  const peer = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    bundlePolicy: "max-bundle",
  });
  const notify = () => onState(peer);
  peer.addEventListener("connectionstatechange", notify);
  peer.addEventListener("iceconnectionstatechange", notify);
  peer.addEventListener("signalingstatechange", notify);
  peer.addEventListener("icegatheringstatechange", notify);
  return peer;
}

async function createCallsSession(credentials: Credentials, peerConnection: RTCPeerConnection): Promise<CallsSession> {
  const response = await callsFetch(credentials, "/sessions/new", { method: "POST" });
  if (!response.sessionId) throw new Error("Cloudflare 没有返回 sessionId。");
  return { id: response.sessionId, peerConnection };
}

async function establishDataChannelTransport(credentials: Credentials, session: CallsSession) {
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

async function createPublisherChannel(credentials: Credentials, session: CallsSession, dataChannelName: string) {
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

async function createSubscriberChannel(
  credentials: Credentials,
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

function waitForDataChannelOpen(channel: RTCDataChannel, peer: RTCPeerConnection, timeoutMs = channelOpenTimeoutMs) {
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
      peer.removeEventListener("connectionstatechange", onPeerState);
      if (error) reject(error);
      else resolve();
    };
    const onOpen = () => done();
    const onClose = () => done(new Error("DataChannel 已关闭，连接没有建立。"));
    const onError = () => done(new Error("DataChannel 发生错误，连接没有建立。"));
    const onPeerState = () => {
      if (peer.connectionState === "failed" || peer.connectionState === "closed") {
        done(new Error(`PeerConnection 连接失败：${peer.connectionState}。`));
      }
    };
    const timer = window.setTimeout(() => {
      done(new Error(`DataChannel 没有打开。当前状态：peer=${peer.connectionState}，channel=${channel.readyState}。`));
    }, timeoutMs);

    channel.addEventListener("open", onOpen);
    channel.addEventListener("close", onClose);
    channel.addEventListener("error", onError);
    peer.addEventListener("connectionstatechange", onPeerState);
    onPeerState();
  });
}

function waitForBuffer(channel: RTCDataChannel, onWait?: () => void) {
  if (channel.readyState !== "open") return Promise.reject(new Error("DataChannel 已关闭，发送已中断。"));
  if (channel.bufferedAmount <= highWaterMark) return Promise.resolve();

  onWait?.();
  return new Promise<void>((resolve, reject) => {
    let finished = false;
    const previousThreshold = channel.bufferedAmountLowThreshold;
    const done = (error?: Error) => {
      if (finished) return;
      finished = true;
      channel.removeEventListener("bufferedamountlow", onLow);
      channel.removeEventListener("close", onClose);
      channel.removeEventListener("error", onError);
      channel.bufferedAmountLowThreshold = previousThreshold;
      if (error) reject(error);
      else resolve();
    };
    const onLow = () => {
      if (channel.bufferedAmount <= lowWaterMark) done();
    };
    const onClose = () => done(new Error("DataChannel 已关闭，发送已中断。"));
    const onError = () => done(new Error("DataChannel 发生错误，发送已中断。"));

    channel.bufferedAmountLowThreshold = lowWaterMark;
    channel.addEventListener("bufferedamountlow", onLow);
    channel.addEventListener("close", onClose);
    channel.addEventListener("error", onError);
    onLow();
  });
}

export function createSfuPage() {
  return function SfuPage() {
  const senderSessionRef = useRef<CallsSession | null>(null);
  const receiverSessionRef = useRef<CallsSession | null>(null);
  const senderChannelRef = useRef<RTCDataChannel | null>(null);
  const receiverChannelRef = useRef<RTCDataChannel | null>(null);
  const receiveChunksRef = useRef<ArrayBuffer[]>([]);
  const receiveMetaRef = useRef<TransferMeta | null>(null);
  const receivedBytesRef = useRef(0);
  const receiveProgressUpdateAtRef = useRef(0);
  const receivedFilesRef = useRef<ReceivedFile[]>([]);
  const sendInFlightRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [appId, setAppId] = useState("");
  const [appToken, setAppToken] = useState("");
  const [mode, setMode] = useState<Mode>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [connectionCode, setConnectionCode] = useState("");
  const [receiverCodeInput, setReceiverCodeInput] = useState("");
  const [senderStatus, setSenderStatus] = useState("填写 App ID / App Token 并选择文件后创建 SFU 发布通道。");
  const [receiverStatus, setReceiverStatus] = useState("粘贴发送方 SFU 连接码后订阅 DataChannel。");
  const [senderError, setSenderError] = useState("");
  const [receiverError, setReceiverError] = useState("");
  const [senderPeerState, setSenderPeerState] = useState("new");
  const [senderIceState, setSenderIceState] = useState("new");
  const [receiverPeerState, setReceiverPeerState] = useState("new");
  const [receiverIceState, setReceiverIceState] = useState("new");
  const [senderChannelState, setSenderChannelState] = useState("closed");
  const [receiverChannelState, setReceiverChannelState] = useState("closed");
  const [publisherSessionId, setPublisherSessionId] = useState("");
  const [subscriberSessionId, setSubscriberSessionId] = useState("");
  const [dataChannelName, setDataChannelName] = useState("");
  const [incomingMeta, setIncomingMeta] = useState<TransferMeta | null>(null);
  const [sentBytes, setSentBytes] = useState(0);
  const [receivedBytes, setReceivedBytes] = useState(0);
  const [senderProgress, setSenderProgress] = useState(0);
  const [receiverProgress, setReceiverProgress] = useState(0);
  const [isCreatingPublisher, setIsCreatingPublisher] = useState(false);
  const [isCreatingSubscriber, setIsCreatingSubscriber] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);

  const credentials = useMemo<Credentials>(() => ({ appId, appToken }), [appId, appToken]);
  const totalBytes = selectedFile?.size ?? incomingMeta?.size ?? 0;
  const progress = Math.max(senderProgress, receiverProgress);

  useEffect(() => {
    return () => {
      closeSenderSession();
      closeReceiverSession();
      receivedFilesRef.current.forEach((file) => URL.revokeObjectURL(file.url));
    };
  }, []);

  useEffect(() => {
    receivedFilesRef.current = receivedFiles;
  }, [receivedFiles]);

  function updateSenderPeerState(peer: RTCPeerConnection) {
    setSenderPeerState(peer.connectionState);
    setSenderIceState(peer.iceConnectionState);
  }

  function updateReceiverPeerState(peer: RTCPeerConnection) {
    setReceiverPeerState(peer.connectionState);
    setReceiverIceState(peer.iceConnectionState);
  }

  function closeSenderSession() {
    senderChannelRef.current?.close();
    senderSessionRef.current?.peerConnection.close();
    senderChannelRef.current = null;
    senderSessionRef.current = null;
    setSenderPeerState("new");
    setSenderIceState("new");
    setSenderChannelState("closed");
  }

  function closeReceiverSession() {
    receiverChannelRef.current?.close();
    receiverSessionRef.current?.peerConnection.close();
    receiverChannelRef.current = null;
    receiverSessionRef.current = null;
    receiveChunksRef.current = [];
    receiveMetaRef.current = null;
    receivedBytesRef.current = 0;
    receiveProgressUpdateAtRef.current = 0;
    setReceiverPeerState("new");
    setReceiverIceState("new");
    setReceiverChannelState("closed");
    setIncomingMeta(null);
  }

  function resetAll() {
    closeSenderSession();
    closeReceiverSession();
    setMode(null);
    setConnectionCode("");
    setReceiverCodeInput("");
    setSenderStatus("填写 App ID / App Token 并选择文件后创建 SFU 发布通道。");
    setReceiverStatus("粘贴发送方 SFU 连接码后订阅 DataChannel。");
    setSenderError("");
    setReceiverError("");
    setPublisherSessionId("");
    setSubscriberSessionId("");
    setDataChannelName("");
    setSentBytes(0);
    setReceivedBytes(0);
    setSenderProgress(0);
    setReceiverProgress(0);
    sendInFlightRef.current = false;
    setIsSending(false);
  }

  function handleFile(file: File | null) {
    setSelectedFile(file);
    setConnectionCode("");
    setSentBytes(0);
    setSenderProgress(0);
    if (file) setSenderStatus(`已选择 ${file.name}，可以创建 SFU 发布通道。`);
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
    setSenderChannelState(channel.readyState);
    channel.addEventListener("open", () => {
      setSenderChannelState(channel.readyState);
      setSenderStatus("SFU 发布通道已打开。把连接码复制给接收方，等接收方订阅成功后再发送。");
    });
    channel.addEventListener("close", () => setSenderChannelState(channel.readyState));
    channel.addEventListener("error", () => {
      setSenderError("发送 DataChannel 发生错误。");
      setSenderChannelState(channel.readyState);
    });
  }

  function attachReceiverChannel(channel: RTCDataChannel) {
    receiverChannelRef.current = channel;
    channel.binaryType = "arraybuffer";
    setReceiverChannelState(channel.readyState);
    channel.addEventListener("open", () => {
      setReceiverChannelState(channel.readyState);
      channel.send("ack");
      setReceiverStatus("已订阅 SFU DataChannel，等待发送方传输文件。");
    });
    channel.addEventListener("close", () => setReceiverChannelState(channel.readyState));
    channel.addEventListener("error", () => {
      setReceiverError("接收 DataChannel 发生错误。");
      setReceiverChannelState(channel.readyState);
    });
    channel.addEventListener("message", (event) => {
      void handleReceiverMessage(event.data);
    });
  }

  async function createPublisher() {
    if (!selectedFile) {
      setSenderError("请先选择一个文件。");
      return;
    }

    try {
      setIsCreatingPublisher(true);
      setSenderError("");
      setConnectionCode("");
      setSentBytes(0);
      setSenderProgress(0);
      setSenderStatus("正在创建 Cloudflare SFU session...");
      closeSenderSession();

      const peer = createPeerConnection(updateSenderPeerState);
      const session = await createCallsSession(credentials, peer);
      senderSessionRef.current = session;
      setPublisherSessionId(session.id);

      setSenderStatus("正在建立 SFU DataChannel transport...");
      await establishDataChannelTransport(credentials, session);

      const channelName = `file-${createStableId()}`;
      setDataChannelName(channelName);
      setSenderStatus("正在向 SFU 注册本地 DataChannel...");
      const channel = await createPublisherChannel(credentials, session, channelName);
      attachSenderChannel(channel);
      await waitForDataChannelOpen(channel, peer);

      const code = await encodeConnectionCode({
        kind: "cloudflare-sfu-file-v1",
        publisherSessionId: session.id,
        dataChannelName: channelName,
        file: {
          name: selectedFile.name,
          size: selectedFile.size,
          type: selectedFile.type,
          lastModified: selectedFile.lastModified,
        },
        createdAt: Date.now(),
      });
      setConnectionCode(code);
      setSenderStatus("SFU 发布通道已就绪。复制连接码给接收方，接收方订阅成功后点击发送文件。");
    } catch (error) {
      setSenderError(error instanceof Error ? error.message : "创建 SFU 发布通道失败。");
    } finally {
      setIsCreatingPublisher(false);
    }
  }

  async function subscribeToPublisher() {
    try {
      setIsCreatingSubscriber(true);
      setReceiverError("");
      setReceiverProgress(0);
      setReceivedBytes(0);
      receiveChunksRef.current = [];
      receiveMetaRef.current = null;
      receivedBytesRef.current = 0;
      closeReceiverSession();

      const code = await decodeConnectionCode(receiverCodeInput);
      const meta: TransferMeta = { kind: "meta", ...code.file };
      setIncomingMeta(meta);
      setPublisherSessionId(code.publisherSessionId);
      setDataChannelName(code.dataChannelName);
      setReceiverStatus("正在创建接收方 Cloudflare SFU session...");

      const peer = createPeerConnection(updateReceiverPeerState);
      const session = await createCallsSession(credentials, peer);
      receiverSessionRef.current = session;
      setSubscriberSessionId(session.id);

      setReceiverStatus("正在建立接收方 SFU DataChannel transport...");
      await establishDataChannelTransport(credentials, session);

      setReceiverStatus("正在订阅发送方 DataChannel...");
      const channel = await createSubscriberChannel(credentials, session, code.publisherSessionId, code.dataChannelName);
      attachReceiverChannel(channel);
      await waitForDataChannelOpen(channel, peer);
      setReceiverStatus("已订阅 SFU DataChannel，等待发送方传输文件。");
    } catch (error) {
      setReceiverError(error instanceof Error ? error.message : "订阅 SFU DataChannel 失败。");
    } finally {
      setIsCreatingSubscriber(false);
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
      setSenderStatus("正在通过 Cloudflare SFU DataChannel 发送文件...");
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
        await waitForBuffer(channel, () => publishProgress(offset));
        channel.send(buffer);
        offset += buffer.byteLength;
        const now = performance.now();
        if (offset >= file.size || channel.bufferedAmount > highWaterMark || now - lastProgressUpdateAt >= progressUpdateIntervalMs) {
          publishProgress(offset);
        }
      }

      const done: TransferDone = { kind: "done" };
      await waitForBuffer(channel, () => publishProgress(offset));
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

  const senderReady = senderChannelState === "open";
  const receiverReady = receiverChannelState === "open";
  const codeSize = connectionCode ? `${connectionCode.length.toLocaleString()} 字符` : "";
  const steps: TransferStepItem[] = [
    { label: "凭证", meta: appId && appToken ? "已填写" : "等待填写", icon: Server, active: Boolean(appId && appToken) },
    { label: "发布", meta: publisherSessionId ? "已创建" : "等待创建", icon: UploadCloud, active: Boolean(publisherSessionId) },
    { label: "订阅", meta: receiverReady ? "已订阅" : "等待订阅", icon: Link2, active: receiverReady },
    { label: "文件", meta: progress >= 100 ? "已完成" : progress > 0 ? "传输中" : "等待传输", icon: Check, active: progress >= 100 },
  ];
  const details: MetricItem[] = [
    { label: "连接类型", value: "Cloudflare SFU DataChannel", icon: Link2 },
    { label: "API", value: "rtc.live.cloudflare.com/v1", icon: Server },
    { label: "发布 Session", value: publisherSessionId || "未创建", icon: UploadCloud, active: Boolean(publisherSessionId) },
    { label: "订阅 Session", value: subscriberSessionId || "未创建", icon: Download, active: Boolean(subscriberSessionId) },
    { label: "发送端状态", value: `${senderPeerState} / ${senderIceState}`, icon: Circle, active: senderPeerState === "connected" },
    { label: "接收端状态", value: `${receiverPeerState} / ${receiverIceState}`, icon: Circle, active: receiverPeerState === "connected" },
    { label: "发送通道", value: senderChannelState, icon: Wifi, active: senderReady },
    { label: "接收通道", value: receiverChannelState, icon: Wifi, active: receiverReady },
    { label: "DataChannel", value: dataChannelName || "未注册", icon: FileText },
    { label: "选中文件", value: selectedFile ? selectedFile.name : incomingMeta?.name ?? "未选择", icon: HardDrive },
    { label: "文件大小", value: totalBytes ? formatBytes(totalBytes) : "0 B", icon: Database },
    { label: "已发送", value: formatBytes(sentBytes), icon: UploadCloud },
    { label: "已接收", value: formatBytes(receivedBytes), icon: Download },
    { label: "进度", value: formatPercent(progress), icon: Gauge, progress },
  ];

  return (
    <TransferPageGrid>
      <StatusPanel>
        <div className="mb-5 flex shrink-0 items-start justify-between gap-4">
          <div>
            <h2 className="text-[22px] font-extrabold text-[#061b3a]">SFU 连接状态</h2>
            <p className="mt-1 text-[15px] text-[#526c92]">通过 Cloudflare Realtime SFU 单向 DataChannel 分发文件。</p>
          </div>
          <SecondaryButton onClick={resetAll}>
            <RefreshCw aria-hidden="true" size={17} />
            重置
          </SecondaryButton>
        </div>

        <TransferSteps steps={steps} />

        <div className="my-5 h-px shrink-0 bg-[#e3edf9]" />

        <h2 className="mb-3 shrink-0 text-[22px] font-extrabold text-[#061b3a]">连接详情</h2>
        <MetricGrid items={details} />
      </StatusPanel>

      <MainPanelGrid>
        <ActionPanel>
          <div className="mb-4">
            <h2 className="text-[22px] font-extrabold text-[#061b3a]">Cloudflare SFU</h2>
            <p className="mt-1 text-[15px] text-[#526c92]">App ID / App Token 由用户在浏览器内填写。</p>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
            <TextInput label="App ID" value={appId} onChange={setAppId} placeholder="Cloudflare Realtime App ID" />
            <TextInput label="App Token" value={appToken} onChange={setAppToken} placeholder="Bearer token" type="password" />
          </div>

          {!mode && (
            <div className="grid gap-3">
              <RoleOption
                title="发送文件"
                description="创建发布通道并复制连接码"
                icon={UploadCloud}
                onClick={() => setMode("send")}
              />
              <RoleOption
                title="接收文件"
                description="粘贴连接码并订阅 SFU DataChannel"
                icon={Download}
                onClick={() => setMode("receive")}
              />
            </div>
          )}

          {mode === "send" && (
            <div className="grid gap-4">
              <TextArea
                label={`发送方 SFU 连接码 ${codeSize}`}
                value={connectionCode}
                onChange={setConnectionCode}
                placeholder="选择文件并创建发布通道后，把这一整串连接码复制给接收方"
                readOnly
              />
              <div className="flex flex-wrap gap-3">
                <PrimaryButton onClick={() => void createPublisher()} disabled={!selectedFile || isCreatingPublisher || isSending}>
                  <Server aria-hidden="true" size={17} />
                  创建发布通道
                </PrimaryButton>
                <SecondaryButton onClick={() => void copyText(connectionCode).catch((error) => setSenderError(error.message))} disabled={!connectionCode}>
                  <Copy aria-hidden="true" size={17} />
                  复制连接码
                </SecondaryButton>
                <PrimaryButton onClick={() => void sendSelectedFile()} disabled={!senderReady || isSending || senderProgress >= 100}>
                  <Send aria-hidden="true" size={17} />
                  发送文件
                </PrimaryButton>
              </div>
              <StatusMessage message={senderError || senderStatus} tone={senderError ? "error" : "info"} />
            </div>
          )}

          {mode === "receive" && (
            <div className="grid gap-4">
              <TextArea
                label="发送方 SFU 连接码"
                value={receiverCodeInput}
                onChange={setReceiverCodeInput}
                placeholder="把发送方复制出来的 SFU 连接码粘贴到这里"
              />
              <div className="flex flex-wrap gap-3">
                <PrimaryButton onClick={() => void subscribeToPublisher()} disabled={!receiverCodeInput.trim() || isCreatingSubscriber || receiverReady}>
                  <Link2 aria-hidden="true" size={17} />
                  订阅 DataChannel
                </PrimaryButton>
              </div>
              <StatusMessage message={receiverError || receiverStatus} tone={receiverError ? "error" : "info"} />
            </div>
          )}
        </ActionPanel>

        <UploadPanel>
          <FilePickerPanel
            inputRef={fileInputRef}
            onFileInput={handleFileInput}
            onDrop={handleDrop}
            ariaLabel="选择发送文件"
            title={selectedFile?.name}
            titleFallback="点击或拖拽文件到此处上传"
            subtitle={selectedFile ? formatBytes(selectedFile.size) : "发送端选择文件后创建 SFU 发布通道"}
            onSelect={() => fileInputRef.current?.click()}
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
