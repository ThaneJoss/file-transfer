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
import {
  CallsSession,
  createCallsSession,
  createPublisherChannel,
  createSubscriberChannel,
  establishDataChannelTransport,
  SfuCredentials,
} from "../features/sfu/services/callsApi";
import { decodeConnectionPayload, encodeConnectionPayload } from "../features/transfer/protocol/connectionCode";
import { waitForBuffer, waitForDataChannelOpen } from "../features/transfer/services/dataChannel";
import {
  ActionPanel,
  ConnectionDetails,
  FilePickerPanel,
  FilesPanel,
  MainPanelGrid,
  ReceivedFilesPanel,
  RoleOption,
  StatusPanel,
  TransferPageGrid,
  TransferSteps,
  UploadPanel,
} from "../layout/TransferLayout";
import type { MetricItem, TransferStepItem } from "../layout/TransferLayout";
import { copyText } from "../lib/browser/clipboard";
import { saveBlob } from "../lib/browser/download";
import { createStableId } from "../lib/browser/stableId";
import { formatBytes, formatPercent } from "../lib/files/format";

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

type ReceivedFile = {
  id: string;
  name: string;
  size: number;
  type: string;
  url: string;
  receivedAt: string;
};

type Mode = "send" | "receive" | null;

const chunkSize = 256 * 1024;
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
  const [statusPanelView, setStatusPanelView] = useState<"status" | "details">("status");

  const credentials = useMemo<SfuCredentials>(() => ({ appId, appToken }), [appId, appToken]);
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
    setStatusPanelView("status");
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
      await waitForDataChannelOpen(channel, peer, { timeoutMs: channelOpenTimeoutMs });

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
        {statusPanelView === "details" ? (
          <>
            <div className="mb-5 flex shrink-0 items-start justify-between gap-4">
              <div>
                <h2 className="text-[22px] font-extrabold text-[#061b3a]">连接详情</h2>
                <p className="mt-1 text-[15px] text-[#526c92]">查看 SFU 会话、DataChannel、Peer 状态和文件进度。</p>
              </div>
              <SecondaryButton onClick={() => setStatusPanelView("status")}>
                <ArrowLeft aria-hidden="true" size={17} />
                返回状态
              </SecondaryButton>
            </div>

            <ConnectionDetails items={details} expanded showHeading={false} />
          </>
        ) : (
          <>
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

            <ConnectionDetails items={details} onShowMore={() => setStatusPanelView("details")} />
          </>
        )}
      </StatusPanel>

      <MainPanelGrid>
        <ActionPanel>
          <div className="mb-4">
            <h2 className="text-[22px] font-extrabold text-[#061b3a]">Cloudflare SFU</h2>
            <p className="mt-1 text-[15px] text-[#526c92]">App ID / App Token 由用户在浏览器内填写。</p>
          </div>

          <div className="adaptive-field-grid mb-4">
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
