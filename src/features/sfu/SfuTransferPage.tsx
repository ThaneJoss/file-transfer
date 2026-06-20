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
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, ReactNode } from "react";

import { PrimaryButton, SecondaryButton, StatusMessage, TextArea, TextInput } from "../../component/TransferControls";
import {
  CallsSession,
  createCallsSession,
  createPublisherChannel,
  createSubscriberChannel,
  establishDataChannelTransport,
} from "./services/callsApi";
import { callsApiOrigin } from "./services/callsApi";
import {
  createSha256Hasher,
  decodeSfuFileChunk,
  encodeSfuFileChunk,
  getSfuChunkPayloadSize,
  memoryReceiveLimitBytes,
  openReceiveSink,
  pickFileSystemReceiveTarget,
  sfuFileProtocolKind,
  sha256File,
  supportsFileSystemReceive,
} from "./services/fileTransfer";
import type {
  ReceiveSink,
  ReceiveTarget,
  SfuTransferDone,
  SfuTransferFile,
  SfuTransferMeta,
} from "./services/fileTransfer";
import { decodeConnectionPayload, encodeConnectionPayload } from "../transfer/protocol/connectionCode";
import { waitForBuffer, waitForDataChannelOpen } from "../transfer/services/dataChannel";
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
import { copyText } from "../../lib/browser/clipboard";
import { saveBlob } from "../../lib/browser/download";
import { notifyApiUsageChanged } from "../../lib/api/client";
import { useAuth } from "../../lib/auth/AuthProvider";
import { createStableId } from "../../lib/browser/stableId";
import { formatBytes, formatPercent } from "../../lib/files/format";
import { createPickup, getPickup } from "../transfer/services/pickupApi";
import type { PendingPickup } from "../transfer/services/pickupApi";

type SfuConnectionCode = {
  kind: typeof sfuFileProtocolKind;
  publisherSessionId: string;
  dataChannelName: string;
  file: SfuTransferFile;
  createdAt: number;
};

type ReceivedFile = {
  id: string;
  name: string;
  size: number;
  type: string;
  url: string | null;
  savedToDisk: boolean;
  receivedAt: string;
};

type ReceiveState = {
  meta: SfuTransferMeta;
  sink: ReceiveSink;
  hasher: ReturnType<typeof createSha256Hasher>;
  nextSequence: number;
  bytes: number;
};

type Mode = "send" | "receive" | null;

const highWaterMark = 16 * 1024 * 1024;
const lowWaterMark = 4 * 1024 * 1024;
const progressUpdateIntervalMs = 100;
const channelOpenTimeoutMs = 30000;

async function encodeConnectionCode(payload: SfuConnectionCode) {
  return encodeConnectionPayload(payload);
}

async function decodeConnectionCode(value: string): Promise<SfuConnectionCode> {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("请先粘贴 SFU 连接码。");

  const json = await decodeConnectionPayload(trimmed, "当前浏览器不能解压 D1 连接码，请换用最新版 Chrome、Edge 或 Safari。");

  const payload = JSON.parse(json) as SfuConnectionCode;
  if (
    payload.kind !== sfuFileProtocolKind ||
    !payload.publisherSessionId ||
    !payload.dataChannelName ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.file?.fileId ?? "") ||
    !payload.file?.name ||
    !Number.isSafeInteger(payload.file.size) ||
    payload.file.size < 0 ||
    !Number.isSafeInteger(payload.file.chunkSize) ||
    payload.file.chunkSize <= 0 ||
    !Number.isSafeInteger(payload.file.totalChunks) ||
    payload.file.totalChunks < 0 ||
    payload.file.totalChunks !== (payload.file.size === 0 ? 0 : Math.ceil(payload.file.size / payload.file.chunkSize))
  ) {
    throw new Error("SFU 连接码格式不正确。");
  }
  return payload;
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

export function SfuTransferPage({
  methodSelector,
  pendingPickup,
  onPickupVariantResolved,
}: {
  methodSelector?: ReactNode;
  pendingPickup?: PendingPickup | null;
  onPickupVariantResolved?: (pending: PendingPickup) => void;
}) {
  const { session } = useAuth();
  const senderSessionRef = useRef<CallsSession | null>(null);
  const receiverSessionRef = useRef<CallsSession | null>(null);
  const senderChannelRef = useRef<RTCDataChannel | null>(null);
  const receiverChannelRef = useRef<RTCDataChannel | null>(null);
  const receiveStateRef = useRef<ReceiveState | null>(null);
  const receiveTargetRef = useRef<ReceiveTarget | null>(null);
  const receiveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const receivedBytesRef = useRef(0);
  const receiveProgressUpdateAtRef = useRef(0);
  const receivedFilesRef = useRef<ReceivedFile[]>([]);
  const sendInFlightRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const consumedPendingPickupRef = useRef("");

  const [mode, setMode] = useState<Mode>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [connectionCode, setConnectionCode] = useState("");
  const [senderPickupCode, setSenderPickupCode] = useState("");
  const [pickupExpiresAt, setPickupExpiresAt] = useState<number | null>(null);
  const [receiverCodeInput, setReceiverCodeInput] = useState("");
  const [receiverPickupInput, setReceiverPickupInput] = useState("");
  const [parsedReceiverCode, setParsedReceiverCode] = useState<SfuConnectionCode | null>(null);
  const [receiveTargetLabel, setReceiveTargetLabel] = useState("");
  const [senderTransfer, setSenderTransfer] = useState<SfuTransferFile | null>(null);
  const [senderStatus, setSenderStatus] = useState("选择文件后通过后端创建 SFU 发布通道。");
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
  const [incomingMeta, setIncomingMeta] = useState<SfuTransferFile | null>(null);
  const [sentBytes, setSentBytes] = useState(0);
  const [receivedBytes, setReceivedBytes] = useState(0);
  const [senderProgress, setSenderProgress] = useState(0);
  const [receiverProgress, setReceiverProgress] = useState(0);
  const [isCreatingPublisher, setIsCreatingPublisher] = useState(false);
  const [isCreatingSubscriber, setIsCreatingSubscriber] = useState(false);
  const [isPickupBusy, setIsPickupBusy] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const [statusPanelView, setStatusPanelView] = useState<"status" | "details">("status");
  const pickupEnabled = Boolean(session?.user);

  const totalBytes = selectedFile?.size ?? incomingMeta?.size ?? 0;
  const progress = Math.max(senderProgress, receiverProgress);
  const fileSystemReceiveSupported = supportsFileSystemReceive();

  useEffect(() => {
    return () => {
      closeSenderSession();
      closeReceiverSession();
      receivedFilesRef.current.forEach((file) => {
        if (file.url) URL.revokeObjectURL(file.url);
      });
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
    setSenderTransfer(null);
    setSenderPeerState("new");
    setSenderIceState("new");
    setSenderChannelState("closed");
  }

  function closeReceiverSession(preserveTarget = false) {
    receiverChannelRef.current?.close();
    receiverSessionRef.current?.peerConnection.close();
    receiverChannelRef.current = null;
    receiverSessionRef.current = null;
    const receiveState = receiveStateRef.current;
    receiveStateRef.current = null;
    if (receiveState) void receiveState.sink.abort();
    receiveQueueRef.current = Promise.resolve();
    if (!preserveTarget) {
      receiveTargetRef.current = null;
      setReceiveTargetLabel("");
    }
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
    setStatusPanelView("status");
    setMode(null);
    setSelectedFile(null);
    setConnectionCode("");
    setSenderPickupCode("");
    setPickupExpiresAt(null);
    setReceiverCodeInput("");
    setReceiverPickupInput("");
    setParsedReceiverCode(null);
    setSenderTransfer(null);
    setSenderStatus("选择文件后通过后端创建 SFU 发布通道。");
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
    setIsPickupBusy(false);
    sendInFlightRef.current = false;
    setIsSending(false);
  }

  function handleFile(file: File | null) {
    closeSenderSession();
    setSelectedFile(file);
    setConnectionCode("");
    setSenderPickupCode("");
    setPickupExpiresAt(null);
    setSenderTransfer(null);
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

  function handleReceiverCodeInput(value: string) {
    closeReceiverSession();
    setReceiverCodeInput(value);
    setReceiverPickupInput("");
    setParsedReceiverCode(null);
    setIncomingMeta(null);
    setReceivedBytes(0);
    setReceiverProgress(0);
    setReceiverError("");
    setReceiverStatus(value.trim() ? "请先读取 SFU 连接码。" : "粘贴发送方 SFU 连接码后订阅 DataChannel。");
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
      receiveQueueRef.current = receiveQueueRef.current
        .then(() => handleReceiverMessage(event.data))
        .catch((error) => handleReceiveFailure(error));
    });
  }

  async function createPublisher() {
    if (!selectedFile) {
      setSenderError("请先选择一个文件。");
      return;
    }
    const file = selectedFile;

    try {
      setIsCreatingPublisher(true);
      setSenderError("");
      setConnectionCode("");
      setSentBytes(0);
      setSenderProgress(0);
      setSenderStatus("正在创建 Cloudflare SFU session...");
      closeSenderSession();

      const peer = createPeerConnection(updateSenderPeerState);
      const session = await createCallsSession(peer);
      senderSessionRef.current = session;
      setPublisherSessionId(session.id);

      setSenderStatus("正在建立 SFU DataChannel transport...");
      await establishDataChannelTransport(session);

      const channelName = `file-${createStableId()}`;
      setDataChannelName(channelName);
      setSenderStatus("正在向 SFU 注册本地 DataChannel...");
      const channel = await createPublisherChannel(session, channelName);
      attachSenderChannel(channel);
      await waitForDataChannelOpen(channel, peer, { timeoutMs: channelOpenTimeoutMs });

      const chunkSize = getSfuChunkPayloadSize(peer);
      const transfer: SfuTransferFile = {
        fileId: createStableId(),
        name: file.name,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
        chunkSize,
        totalChunks: file.size === 0 ? 0 : Math.ceil(file.size / chunkSize),
      };
      setSenderTransfer(transfer);

      const code = await encodeConnectionCode({
        kind: sfuFileProtocolKind,
        publisherSessionId: session.id,
        dataChannelName: channelName,
        file: transfer,
        createdAt: Date.now(),
      });
      setConnectionCode(code);
      if (pickupEnabled) {
        setSenderStatus("SFU 发布通道已就绪，正在写入取件码...");
        try {
          const pickup = await createPickup("sfu", code);
          setSenderPickupCode(pickup.code);
          setPickupExpiresAt(pickup.expiresAt);
          setSenderStatus(`取件码 ${pickup.code} 已生成。接收方输入取件码订阅成功后，再点击发送文件。`);
        } catch (error) {
          setSenderError(`SFU 发布通道已就绪，但取件码生成失败：${error instanceof Error ? error.message : "未知错误"}`);
          setSenderStatus("可先复制连接码给接收方。");
        }
      } else {
        setSenderStatus("SFU 发布通道已就绪。复制连接码给接收方，接收方订阅成功后点击发送文件。");
      }
    } catch (error) {
      setSenderError(error instanceof Error ? error.message : "创建 SFU 发布通道失败。");
    } finally {
      setIsCreatingPublisher(false);
    }
  }

  async function readReceiverCode(codeOverride = receiverCodeInput) {
    try {
      setReceiverError("");
      closeReceiverSession();
      const code = await decodeConnectionCode(codeOverride);
      setReceiverCodeInput(codeOverride);
      if (!fileSystemReceiveSupported && code.file.size > memoryReceiveLimitBytes) {
        throw new Error(
          `当前浏览器不能直接流式写盘，内存回退只允许 ${formatBytes(memoryReceiveLimitBytes)} 以内的文件。请改用支持文件系统访问的 Chromium 浏览器。`,
        );
      }

      setParsedReceiverCode(code);
      setIncomingMeta(code.file);
      setPublisherSessionId(code.publisherSessionId);
      setDataChannelName(code.dataChannelName);
      if (fileSystemReceiveSupported) {
        setReceiverStatus(`已读取 ${code.file.name}，请先选择保存位置。`);
      } else {
        receiveTargetRef.current = { kind: "memory" };
        setReceiveTargetLabel("浏览器内存");
        setReceiverStatus(`已读取 ${code.file.name}，当前浏览器将使用内存接收并在完成后下载。`);
      }
    } catch (error) {
      setParsedReceiverCode(null);
      setIncomingMeta(null);
      setReceiverError(error instanceof Error ? error.message : "读取 SFU 连接码失败。");
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
      if (pickup.variant !== "sfu") {
        onPickupVariantResolved?.({ code, pickup });
        setReceiverStatus(`取件码属于 ${pickup.variant.toUpperCase()}，正在切换传输方法。`);
        return;
      }
      await readReceiverCode(pickup.offer);
      setReceiverStatus((current) => current.replace("已读取", `取件码 ${code} 已读取`));
    } catch (error) {
      setReceiverError(error instanceof Error ? error.message : "读取取件码失败。");
    } finally {
      setIsPickupBusy(false);
    }
  }

  useEffect(() => {
    if (!pendingPickup || pendingPickup.pickup.variant !== "sfu") return;
    const key = `${pendingPickup.code}:${pendingPickup.pickup.expiresAt}:${pendingPickup.pickup.offer}`;
    if (consumedPendingPickupRef.current === key) return;
    consumedPendingPickupRef.current = key;
    setMode("receive");
    setReceiverPickupInput(pendingPickup.code);
    setIsPickupBusy(true);
    setReceiverStatus(`取件码 ${pendingPickup.code} 已读取，正在解析 SFU 连接码...`);
    void readReceiverCode(pendingPickup.pickup.offer).finally(() => setIsPickupBusy(false));
  }, [pendingPickup]);

  async function chooseReceiveTarget() {
    if (!parsedReceiverCode) {
      setReceiverError("请先读取 SFU 连接码。");
      return;
    }
    try {
      setReceiverError("");
      const target = await pickFileSystemReceiveTarget(parsedReceiverCode.file.name);
      receiveTargetRef.current = target;
      setReceiveTargetLabel(target.kind === "file-system" ? target.handle.name : "浏览器内存");
      setReceiverStatus(`保存位置已准备：${target.kind === "file-system" ? target.handle.name : "浏览器内存"}。`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setReceiverError(error instanceof Error ? error.message : "选择保存位置失败。");
    }
  }

  async function subscribeToPublisher() {
    try {
      const code = parsedReceiverCode;
      if (!code) throw new Error("请先读取 SFU 连接码。");
      if (!receiveTargetRef.current) throw new Error("请先选择保存位置。");
      setIsCreatingSubscriber(true);
      setReceiverError("");
      setReceiverProgress(0);
      setReceivedBytes(0);
      receivedBytesRef.current = 0;
      closeReceiverSession(true);

      setIncomingMeta(code.file);
      setPublisherSessionId(code.publisherSessionId);
      setDataChannelName(code.dataChannelName);
      setReceiverStatus("正在创建接收方 Cloudflare SFU session...");

      const peer = createPeerConnection(updateReceiverPeerState);
      const session = await createCallsSession(peer);
      receiverSessionRef.current = session;
      setSubscriberSessionId(session.id);

      setReceiverStatus("正在建立接收方 SFU DataChannel transport...");
      await establishDataChannelTransport(session);

      setReceiverStatus("正在订阅发送方 DataChannel...");
      const channel = await createSubscriberChannel(session, code.publisherSessionId, code.dataChannelName);
      attachReceiverChannel(channel);
      await waitForDataChannelOpen(channel, peer, { timeoutMs: channelOpenTimeoutMs });
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
    const transfer = senderTransfer;
    if (!file || !channel || !transfer || channel.readyState !== "open" || isSending || sendInFlightRef.current || senderProgress >= 100) return;
    if (
      file.name !== transfer.name ||
      file.size !== transfer.size ||
      file.lastModified !== transfer.lastModified
    ) {
      setSenderError("文件已经变化，请重新创建 SFU 发布通道。");
      return;
    }

    sendInFlightRef.current = true;
    try {
      setIsSending(true);
      setSenderError("");
      setSenderStatus("正在计算文件 SHA-256...");
      setSentBytes(0);
      setSenderProgress(0);

      const fileSha256 = await sha256File(file, (bytes) => {
        setSenderStatus(`正在计算文件 SHA-256：${formatPercent(file.size ? (bytes / file.size) * 100 : 100)}`);
      });
      const meta: SfuTransferMeta = {
        kind: "meta",
        ...transfer,
        sha256: fileSha256,
      };
      channel.send(JSON.stringify(meta));
      setSenderStatus("正在通过 Cloudflare SFU DataChannel 发送文件...");

      let offset = 0;
      let sequence = 0;
      let lastProgressUpdateAt = 0;
      const publishProgress = (bytes: number) => {
        lastProgressUpdateAt = performance.now();
        setSentBytes(bytes);
        setSenderProgress(file.size ? (bytes / file.size) * 100 : 100);
      };

      while (offset < file.size) {
        const buffer = await file.slice(offset, offset + transfer.chunkSize).arrayBuffer();
        const message = encodeSfuFileChunk(transfer.fileId, sequence, new Uint8Array(buffer));
        await waitForBuffer(channel, { highWaterMark, lowWaterMark, onWait: () => publishProgress(offset) });
        channel.send(message);
        offset += buffer.byteLength;
        sequence += 1;
        const now = performance.now();
        if (offset >= file.size || channel.bufferedAmount > highWaterMark || now - lastProgressUpdateAt >= progressUpdateIntervalMs) {
          publishProgress(offset);
        }
      }

      if (sequence !== transfer.totalChunks) throw new Error("SFU 文件分块数量与连接码不一致。");
      const done: SfuTransferDone = {
        kind: "done",
        fileId: transfer.fileId,
        totalChunks: transfer.totalChunks,
        sha256: fileSha256,
      };
      await waitForBuffer(channel, { highWaterMark, lowWaterMark, onWait: () => publishProgress(offset) });
      channel.send(JSON.stringify(done));
      setSentBytes(file.size);
      setSenderProgress(100);
      setSenderStatus("文件已发送完成。");
      notifyApiUsageChanged();
    } catch (error) {
      setSenderError(error instanceof Error ? error.message : "发送文件失败。");
    } finally {
      sendInFlightRef.current = false;
      setIsSending(false);
    }
  }

  async function handleReceiverMessage(data: unknown) {
    if (typeof data === "string") {
      let message: SfuTransferMeta | SfuTransferDone;
      try {
        message = JSON.parse(data) as SfuTransferMeta | SfuTransferDone;
      } catch {
        throw new Error("收到无法识别的 SFU 文件控制消息。");
      }

      if (message.kind === "meta") {
        const expected = parsedReceiverCode?.file;
        const target = receiveTargetRef.current;
        if (!expected || !target) throw new Error("接收端尚未准备连接码或保存位置。");
        if (
          !/^[0-9a-f]{64}$/i.test(message.sha256) ||
          message.fileId !== expected.fileId ||
          message.name !== expected.name ||
          message.size !== expected.size ||
          message.chunkSize !== expected.chunkSize ||
          message.totalChunks !== expected.totalChunks
        ) {
          throw new Error("发送方文件元数据与连接码不一致。");
        }

        const previous = receiveStateRef.current;
        if (previous) await previous.sink.abort();
        const sink = await openReceiveSink(target, message.type);
        receiveStateRef.current = {
          meta: message,
          sink,
          hasher: createSha256Hasher(),
          nextSequence: 0,
          bytes: 0,
        };
        receivedBytesRef.current = 0;
        receiveProgressUpdateAtRef.current = 0;
        setIncomingMeta(message);
        setReceivedBytes(0);
        setReceiverProgress(0);
        setReceiverStatus(`正在接收 ${message.name}。`);
        return;
      }

      if (message.kind === "done") {
        const state = receiveStateRef.current;
        if (!state) throw new Error("收到完成信号，但缺少文件元数据。");
        const { meta } = state;
        if (
          message.fileId !== meta.fileId ||
          message.totalChunks !== meta.totalChunks ||
          message.sha256 !== meta.sha256 ||
          state.nextSequence !== meta.totalChunks ||
          state.bytes !== meta.size
        ) {
          throw new Error("SFU 文件完成信息与实际接收数据不一致。");
        }
        const receivedSha256 = state.hasher.digestHex();
        if (receivedSha256 !== meta.sha256) {
          throw new Error(`SHA-256 校验失败：期望 ${meta.sha256}，实际 ${receivedSha256}。`);
        }

        const blob = await state.sink.close();
        const url = blob ? URL.createObjectURL(blob) : null;
        const receivedFile: ReceivedFile = {
          id: meta.fileId,
          name: meta.name,
          size: state.bytes,
          type: meta.type,
          url,
          savedToDisk: state.sink.kind === "file-system",
          receivedAt: new Date().toLocaleString(),
        };
        setReceivedFiles((files) => [receivedFile, ...files]);
        setReceiverProgress(100);
        setReceivedBytes(state.bytes);
        setReceiverStatus(
          state.sink.kind === "file-system"
            ? `文件接收完成，SHA-256 校验通过，已保存到 ${state.sink.name}。`
            : "文件接收完成，SHA-256 校验通过，已触发浏览器下载。",
        );
        if (url) saveBlob({ name: receivedFile.name, url });
        notifyApiUsageChanged();
        receiveStateRef.current = null;
        receiveTargetRef.current = null;
        return;
      }
      throw new Error("收到不支持的 SFU 文件控制消息。");
    }

    const state = receiveStateRef.current;
    if (!state) throw new Error("收到文件数据，但缺少文件元数据。");
    const buffer = data instanceof ArrayBuffer ? data : await (data as Blob).arrayBuffer();
    const chunk = decodeSfuFileChunk(buffer);
    if (chunk.fileId !== state.meta.fileId) throw new Error("收到其他文件的 SFU 分块。");
    if (chunk.sequence !== state.nextSequence) {
      throw new Error(`SFU 文件分块顺序错误：期望 ${state.nextSequence}，实际 ${chunk.sequence}。`);
    }
    if (chunk.payload.byteLength > state.meta.chunkSize) throw new Error("收到的 SFU 文件分块超过协商大小。");
    if (state.bytes + chunk.payload.byteLength > state.meta.size) throw new Error("接收数据超过声明的文件大小。");

    await state.sink.write(chunk.payload);
    state.hasher.update(chunk.payload);
    state.nextSequence += 1;
    state.bytes += chunk.payload.byteLength;
    receivedBytesRef.current = state.bytes;
    const received = state.bytes;
    const size = state.meta.size;

    const now = performance.now();
    if (size === 0 || received >= size || now - receiveProgressUpdateAtRef.current >= progressUpdateIntervalMs) {
      receiveProgressUpdateAtRef.current = now;
      setReceivedBytes(received);
      setReceiverProgress(size ? (received / size) * 100 : 0);
    }
  }

  async function handleReceiveFailure(error: unknown) {
    const state = receiveStateRef.current;
    receiveStateRef.current = null;
    if (state) await state.sink.abort();
    setReceiverError(error instanceof Error ? error.message : "接收 SFU 文件失败。");
    setReceiverStatus("文件接收失败，已停止写入。");
  }

  const senderReady = senderChannelState === "open";
  const receiverReady = receiverChannelState === "open";
  const codeSize = connectionCode ? `${connectionCode.length.toLocaleString()} 字符` : "";
  const steps: TransferStepItem[] = [
    { label: "会话", meta: publisherSessionId || subscriberSessionId ? "已创建" : "等待创建", icon: Server, active: Boolean(publisherSessionId || subscriberSessionId) },
    { label: "发布", meta: publisherSessionId ? "已创建" : "等待创建", icon: UploadCloud, active: Boolean(publisherSessionId) },
    { label: "订阅", meta: receiverReady ? "已订阅" : "等待订阅", icon: Link2, active: receiverReady },
    { label: "文件", meta: progress >= 100 ? "已完成" : progress > 0 ? "传输中" : "等待传输", icon: Check, active: progress >= 100 },
  ];
  const details: MetricItem[] = [
    { label: "连接类型", value: "Cloudflare SFU DataChannel", icon: Link2 },
    { label: "API", value: callsApiOrigin, icon: Server },
    { label: "发布 Session", value: publisherSessionId || "未创建", icon: UploadCloud, active: Boolean(publisherSessionId) },
    { label: "订阅 Session", value: subscriberSessionId || "未创建", icon: Download, active: Boolean(subscriberSessionId) },
    { label: "发送端状态", value: `${senderPeerState} / ${senderIceState}`, icon: Circle, active: senderPeerState === "connected" },
    { label: "接收端状态", value: `${receiverPeerState} / ${receiverIceState}`, icon: Circle, active: receiverPeerState === "connected" },
    { label: "发送通道", value: senderChannelState, icon: Wifi, active: senderReady },
    { label: "接收通道", value: receiverChannelState, icon: Wifi, active: receiverReady },
    { label: "DataChannel", value: dataChannelName || "未注册", icon: FileText },
    { label: "分块大小", value: formatBytes(senderTransfer?.chunkSize ?? parsedReceiverCode?.file.chunkSize ?? 0), icon: Database },
    { label: "保存位置", value: receiveTargetLabel || "未选择", icon: HardDrive, active: Boolean(receiveTargetLabel) },
    { label: "选中文件", value: selectedFile ? selectedFile.name : incomingMeta?.name ?? "未选择", icon: HardDrive },
    { label: "文件大小", value: totalBytes ? formatBytes(totalBytes) : "0 B", icon: Database },
    { label: "已发送", value: formatBytes(sentBytes), icon: UploadCloud },
    { label: "已接收", value: formatBytes(receivedBytes), icon: Download },
    { label: "进度", value: formatPercent(progress), icon: Gauge, progress },
  ];

  return (
    <TransferPageGrid>
      <StatusPanel>
        {statusPanelView === "details" ? (
          <>
            <StatusPanelHeader
              title="连接详情"
              description="查看 SFU 会话、DataChannel、Peer 状态和文件进度。"
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
              title="SFU 连接状态"
              description="通过 Cloudflare Realtime SFU 单向 DataChannel 分发文件。"
              action={(
                <SecondaryButton onClick={resetAll}>
                  <RefreshCw aria-hidden="true" size={17} />
                  重置
                </SecondaryButton>
              )}
            />

            <TransferSteps steps={steps} />

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

          {!mode && (
            <div className="grid gap-3">
              <RoleOption
                title="发送文件"
                description={pickupEnabled ? "创建发布通道并生成取件码" : "创建发布通道并复制连接码"}
                icon={UploadCloud}
                onClick={() => setMode("send")}
              />
              {methodSelector}
              <RoleOption
                title="接收文件"
                description={pickupEnabled ? "输入取件码并订阅 SFU DataChannel" : "粘贴连接码并订阅 SFU DataChannel"}
                icon={Download}
                onClick={() => {
                  closeReceiverSession();
                  setSelectedFile(null);
                  setConnectionCode("");
                  setParsedReceiverCode(null);
                  setSentBytes(0);
                  setSenderProgress(0);
                  setMode("receive");
                }}
              />
            </div>
          )}

          {mode === "send" && (
            <div className="grid gap-4">
              {pickupEnabled && (
                <div className="grid min-h-[128px] place-items-center rounded-2xl border border-[#b9dcff] bg-[#f1f8ff] p-4 text-center">
                  <div>
                    <div className="text-sm font-bold text-[#526c92]">8 位取件码</div>
                    <div className="mt-2 font-mono text-[32px] font-black tracking-[0.16em] text-[#061b3a]" data-testid="sender-pickup-code">
                      {senderPickupCode || (isCreatingPublisher ? "生成中" : "--------")}
                    </div>
                    <div className="mt-2 text-xs text-[#526c92]">
                      {pickupExpiresAt ? `有效至 ${new Date(pickupExpiresAt).toLocaleTimeString("zh-CN")}` : "创建发布通道后生成"}
                    </div>
                  </div>
                </div>
              )}
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
                {pickupEnabled && (
                  <SecondaryButton onClick={() => void copyText(senderPickupCode).catch((error) => setSenderError(error.message))} disabled={!senderPickupCode}>
                    <Copy aria-hidden="true" size={17} />
                    复制取件码
                  </SecondaryButton>
                )}
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
              {pickupEnabled ? (
                <TextInput
                  label="8 位取件码"
                  value={receiverPickupInput}
                  onChange={(value) => {
                    setReceiverPickupInput(value.replace(/\D/g, "").slice(0, 8));
                    setReceiverError("");
                  }}
                  placeholder="输入发送方提供的 8 位数字"
                />
              ) : (
                <TextArea
                  label="发送方 SFU 连接码"
                  value={receiverCodeInput}
                  onChange={handleReceiverCodeInput}
                  placeholder="把发送方复制出来的 SFU 连接码粘贴到这里"
                />
              )}
              <div className="flex flex-wrap gap-3">
                {pickupEnabled ? (
                  <SecondaryButton onClick={() => void receiveWithPickupCode()} disabled={receiverPickupInput.length !== 8 || isPickupBusy || isCreatingSubscriber || receiverReady}>
                    <FileText aria-hidden="true" size={17} />
                    {isPickupBusy ? "读取中..." : "读取取件码"}
                  </SecondaryButton>
                ) : (
                  <SecondaryButton onClick={() => void readReceiverCode()} disabled={!receiverCodeInput.trim() || isCreatingSubscriber || receiverReady}>
                    <FileText aria-hidden="true" size={17} />
                    读取连接码
                  </SecondaryButton>
                )}
                {fileSystemReceiveSupported && (
                  <SecondaryButton onClick={() => void chooseReceiveTarget()} disabled={!parsedReceiverCode || isCreatingSubscriber || receiverReady}>
                    <HardDrive aria-hidden="true" size={17} />
                    {receiveTargetLabel ? "重新选择保存位置" : "选择保存位置"}
                  </SecondaryButton>
                )}
                <PrimaryButton onClick={() => void subscribeToPublisher()} disabled={!parsedReceiverCode || !receiveTargetLabel || isCreatingSubscriber || receiverReady}>
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
            ariaLabel={mode === "send" ? "选择发送文件" : "文件选择状态"}
            title={selectedFile?.name}
            titleFallback={
              mode === "receive"
                ? "接收端无需选择文件"
                : mode === "send"
                  ? "点击或拖拽文件到此处上传"
                  : "先选择发送文件角色"
            }
            subtitle={
              mode === "receive"
                ? receiveTargetLabel
                  ? `保存到 ${receiveTargetLabel}`
                  : "读取连接码并选择保存位置"
                : mode === "send"
                  ? selectedFile
                    ? formatBytes(selectedFile.size)
                    : "发送端选择文件后创建 SFU 发布通道"
                  : "选择左侧发送文件后启用文件选择"
            }
            onSelect={() => fileInputRef.current?.click()}
            disabled={mode !== "send"}
            icon={mode === "receive" ? Download : UploadCloud}
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
          onDownload={(file) => {
            if (file.url) saveBlob({ name: file.name, url: file.url });
          }}
          canDownload={(file) => Boolean(file.url)}
          getDownloadLabel={(file) => file.savedToDisk ? "已保存" : "下载"}
        />
      </FilesPanel>
    </TransferPageGrid>
  );
}
