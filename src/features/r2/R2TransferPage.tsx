import {
  ArrowLeft,
  Check,
  Copy,
  Database,
  Download,
  FileText,
  Gauge,
  HardDrive,
  Link2,
  RefreshCw,
  Server,
  UploadCloud,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";

import { PrimaryButton, SecondaryButton, StatusMessage, TextArea } from "../../component/TransferControls";
import { decodeConnectionPayload, encodeConnectionPayload } from "../transfer/protocol/connectionCode";
import {
  formatFetchError,
  presignedR2Url,
  r2ObjectUrl,
  sha256Hex,
  signedR2Request,
} from "./services/r2Signing";
import { requestR2Credentials } from "./services/r2Credentials";
import type { R2TemporaryCredentials } from "./services/r2Credentials";
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
import { formatBytes, formatPercent } from "../../lib/files/format";

type R2ConnectionCode = {
  kind: "cloudflare-r2-file-v1";
  objectKey: string;
  presignedUrl: string;
  expiresAt: number;
  file: {
    name: string;
    size: number;
    type: string;
    lastModified: number;
  };
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

async function encodeConnectionCode(payload: R2ConnectionCode) {
  return encodeConnectionPayload(payload);
}

async function decodeConnectionCode(value: string): Promise<R2ConnectionCode> {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("请先粘贴 R2 连接码。");

  const json = await decodeConnectionPayload(trimmed, "当前浏览器不能解压 D1 连接码，请换用最新版 Chrome、Edge 或 Safari。");

  const payload = JSON.parse(json) as R2ConnectionCode;
  let presignedUrl: URL | null = null;
  try {
    presignedUrl = new URL(payload.presignedUrl);
  } catch {
    // The validation below reports one consistent connection-code error.
  }
  if (
    payload.kind !== "cloudflare-r2-file-v1" ||
    !payload.objectKey ||
    !payload.presignedUrl ||
    presignedUrl?.protocol !== "https:" ||
    typeof payload.expiresAt !== "number" ||
    !payload.file?.name ||
    typeof payload.file.size !== "number"
  ) {
    throw new Error("R2 连接码格式不正确。");
  }
  return payload;
}

export function R2TransferPage() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const receivedFilesRef = useRef<ReceivedFile[]>([]);
  const credentialRequestRef = useRef(0);

  const [credentials, setCredentials] = useState<R2TemporaryCredentials | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [objectKey, setObjectKey] = useState("");
  const [connectionCode, setConnectionCode] = useState("");
  const [receiverCodeInput, setReceiverCodeInput] = useState("");
  const [incomingCode, setIncomingCode] = useState<R2ConnectionCode | null>(null);
  const [senderStatus, setSenderStatus] = useState("选择文件后申请临时 R2 凭证并上传。");
  const [receiverStatus, setReceiverStatus] = useState("粘贴 R2 连接码后下载文件。");
  const [senderError, setSenderError] = useState("");
  const [receiverError, setReceiverError] = useState("");
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [senderProgress, setSenderProgress] = useState(0);
  const [receiverProgress, setReceiverProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [isRequestingCredentials, setIsRequestingCredentials] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const [statusPanelView, setStatusPanelView] = useState<"status" | "details">("status");

  useEffect(() => {
    return () => {
      credentialRequestRef.current += 1;
      receivedFilesRef.current.forEach((file) => URL.revokeObjectURL(file.url));
    };
  }, []);

  const totalBytes = selectedFile?.size ?? incomingCode?.file.size ?? 0;
  const progress = Math.max(senderProgress, receiverProgress);
  const endpointLabel = credentials?.endpoint || (incomingCode?.presignedUrl ? new URL(incomingCode.presignedUrl).origin : "未配置");
  const objectUrl = credentials && objectKey
    ? r2ObjectUrl(credentials, objectKey)
    : incomingCode?.presignedUrl
      ? `${new URL(incomingCode.presignedUrl).origin}${new URL(incomingCode.presignedUrl).pathname}`
      : "";
  const expiresAt = incomingCode?.expiresAt ?? (credentials ? Date.parse(credentials.expiresAt) : 0);
  const expiresAtText = expiresAt ? new Date(expiresAt).toLocaleString() : "未生成";

  function clearReceivedFiles() {
    receivedFilesRef.current.forEach((file) => URL.revokeObjectURL(file.url));
    receivedFilesRef.current = [];
    setReceivedFiles([]);
  }

  function resetAll() {
    credentialRequestRef.current += 1;
    setStatusPanelView("status");
    setMode(null);
    setSelectedFile(null);
    setCredentials(null);
    setObjectKey("");
    setConnectionCode("");
    setReceiverCodeInput("");
    setIncomingCode(null);
    setSenderStatus("选择文件后申请临时 R2 凭证并上传。");
    setReceiverStatus("粘贴 R2 连接码后下载文件。");
    setSenderError("");
    setReceiverError("");
    setUploadedBytes(0);
    setDownloadedBytes(0);
    setSenderProgress(0);
    setReceiverProgress(0);
    setIsUploading(false);
    setIsRequestingCredentials(false);
    setIsDownloading(false);
    clearReceivedFiles();
  }

  async function handleFile(file: File | null) {
    const requestVersion = ++credentialRequestRef.current;
    setIsRequestingCredentials(false);
    setSelectedFile(file);
    setCredentials(null);
    setObjectKey("");
    setConnectionCode("");
    setUploadedBytes(0);
    setSenderProgress(0);
    if (file) {
      try {
        setIsRequestingCredentials(true);
        setSenderError("");
        setSenderStatus(`正在为 ${file.name} 申请临时 R2 凭证...`);
        const next = await requestR2Credentials(file.name);
        if (requestVersion !== credentialRequestRef.current) return;
        setCredentials(next);
        setObjectKey(next.objectKey);
        setSenderStatus(`临时 R2 凭证已就绪，对象 Key 由服务端生成。`);
      } catch (error) {
        if (requestVersion === credentialRequestRef.current) setSenderError(formatFetchError(error));
      } finally {
        if (requestVersion === credentialRequestRef.current) setIsRequestingCredentials(false);
      }
    }
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    void handleFile(event.target.files?.[0] ?? null);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    void handleFile(event.dataTransfer.files?.[0] ?? null);
  }

  async function uploadSelectedFile() {
    if (!selectedFile) {
      setSenderError("请先选择一个文件。");
      return;
    }

    if (!credentials || !objectKey) {
      setSenderError("临时 R2 凭证尚未就绪，请重新选择文件。");
      return;
    }
    const key = objectKey;
    try {
      setIsUploading(true);
      setSenderError("");
      setConnectionCode("");
      setUploadedBytes(0);
      setSenderProgress(1);
      setSenderStatus("正在计算文件 SHA-256 并签名 R2 PUT 请求...");
      setObjectKey(key);
      const expiresAt = Date.parse(credentials.expiresAt);
      const expiresIn = Math.min(900, Math.floor((expiresAt - Date.now()) / 1000));
      if (!Number.isFinite(expiresAt) || expiresIn < 1) throw new Error("R2 临时凭证已过期，请重新选择文件。");

      const buffer = await selectedFile.arrayBuffer();
      const payloadHash = await sha256Hex(buffer);
      const signed = await signedR2Request({
        credentials,
        method: "PUT",
        objectKey: key,
        payloadHash,
        contentType: selectedFile.type || "application/octet-stream",
      });

      setSenderStatus("正在上传到 Cloudflare R2...");
      const response = await fetch(signed.url, {
        method: "PUT",
        headers: signed.headers,
        body: buffer,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`R2 上传失败：HTTP ${response.status}${text ? `，${text.slice(0, 180)}` : ""}`);
      }

      setSenderStatus("正在生成预签名下载链接...");
      const presignedUrl = await presignedR2Url({
        credentials,
        method: "GET",
        objectKey: key,
        expiresIn,
      });
      const code = await encodeConnectionCode({
        kind: "cloudflare-r2-file-v1",
        objectKey: key,
        presignedUrl,
        expiresAt,
        file: {
          name: selectedFile.name,
          size: selectedFile.size,
          type: selectedFile.type,
          lastModified: selectedFile.lastModified,
        },
      });
      setUploadedBytes(selectedFile.size);
      setSenderProgress(100);
      setConnectionCode(code);
      setSenderStatus(`文件已上传到 R2。预签名下载链接有效期 ${expiresIn} 秒，复制连接码给接收方。`);
    } catch (error) {
      setSenderError(formatFetchError(error));
      setSenderProgress(0);
      setUploadedBytes(0);
    } finally {
      setIsUploading(false);
    }
  }

  async function parseReceiverCode() {
    try {
      setReceiverError("");
      setDownloadedBytes(0);
      setReceiverProgress(0);
      const code = await decodeConnectionCode(receiverCodeInput);
      setIncomingCode(code);
      setReceiverStatus(
        code.presignedUrl
          ? `已读取连接码：${code.file.name}，${formatBytes(code.file.size)}。接收方无需 R2 凭证。`
          : "这个连接码缺少预签名下载链接，请让发送方用新版 R2 页面重新上传并复制连接码。",
      );
    } catch (error) {
      setReceiverError(error instanceof Error ? error.message : "读取 R2 连接码失败。");
    }
  }

  async function downloadFromR2() {
    try {
      const code = incomingCode ?? (receiverCodeInput.trim() ? await decodeConnectionCode(receiverCodeInput) : null);
      if (!code) {
        setReceiverError("请先粘贴并读取 R2 连接码。");
        return;
      }
      if (!code.presignedUrl) {
        throw new Error("这个连接码缺少预签名下载链接，请让发送方用新版 R2 页面重新上传并复制连接码。");
      }
      if (code.expiresAt && Date.now() > code.expiresAt) {
        throw new Error("预签名下载链接已过期，请让发送方重新上传或重新生成连接码。");
      }

      setIsDownloading(true);
      setReceiverError("");
      setIncomingCode(code);
      setDownloadedBytes(0);
      setReceiverProgress(1);
      setReceiverStatus("正在使用预签名链接从 Cloudflare R2 下载文件...");
      const response = await fetch(code.presignedUrl, {
        method: "GET",
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`R2 下载失败：HTTP ${response.status}${text ? `，${text.slice(0, 180)}` : ""}`);
      }

      const blob = await response.blob();
      const receivedFile: ReceivedFile = {
        id: `${Date.now()}-${code.file.name}`,
        name: code.file.name,
        size: blob.size,
        type: code.file.type,
        url: URL.createObjectURL(blob),
        receivedAt: new Date().toLocaleString(),
      };
      receivedFilesRef.current = [receivedFile, ...receivedFilesRef.current];
      setReceivedFiles(receivedFilesRef.current);
      setDownloadedBytes(blob.size);
      setReceiverProgress(100);
      setReceiverStatus("文件已从 R2 下载完成，已触发浏览器下载。");
      saveBlob(receivedFile);
    } catch (error) {
      setReceiverError(formatFetchError(error));
      setReceiverProgress(0);
      setDownloadedBytes(0);
    } finally {
      setIsDownloading(false);
    }
  }

  const codeSize = connectionCode ? `${connectionCode.length.toLocaleString()} 字符` : "";
  const credentialsReady = mode === "receive" ? Boolean(incomingCode?.presignedUrl || receiverCodeInput.trim()) : Boolean(credentials);
  const steps: TransferStepItem[] = [
    {
      label: mode === "receive" ? "连接码" : "凭证",
      meta: credentialsReady ? (mode === "receive" ? "已粘贴" : "已填写") : mode === "receive" ? "等待粘贴" : "等待填写",
      icon: mode === "receive" ? Link2 : Server,
      active: credentialsReady,
      connectorActive: credentialsReady,
    },
    {
      label: "对象",
      meta: objectKey || incomingCode?.objectKey ? "已定位" : "等待生成",
      icon: FileText,
      active: Boolean(objectKey || incomingCode?.objectKey),
      connectorActive: Boolean(objectKey || incomingCode?.objectKey),
    },
    {
      label: "传输",
      meta: isUploading || isDownloading ? "进行中" : progress >= 100 ? "已完成" : "等待开始",
      icon: UploadCloud,
      active: isUploading || isDownloading || progress >= 100,
      connectorActive: progress >= 100,
    },
    { label: "文件", meta: progress >= 100 ? "可下载" : "等待完成", icon: Check, active: progress >= 100, connectorActive: progress >= 100 },
  ];
  const details: MetricItem[] = [
    { label: "连接类型", value: "Cloudflare R2 S3 API", icon: Link2 },
    { label: "Endpoint", value: endpointLabel, icon: Server, active: Boolean(credentials || incomingCode) },
    { label: "Bucket", value: credentials?.bucket || "仅发送方内存可见", icon: Database, active: Boolean(credentials) },
    { label: "对象 Key", value: objectKey || incomingCode?.objectKey || "未生成", icon: FileText, active: Boolean(objectKey || incomingCode?.objectKey) },
    { label: "对象 URL", value: objectUrl || "未生成", icon: Link2 },
    { label: "下载链接过期", value: expiresAtText, icon: Gauge, active: Boolean(expiresAt) },
    { label: "选中文件", value: selectedFile ? selectedFile.name : incomingCode?.file.name ?? "未选择", icon: HardDrive },
    { label: "文件大小", value: totalBytes ? formatBytes(totalBytes) : "0 B", icon: Database },
    { label: "已上传", value: formatBytes(uploadedBytes), icon: UploadCloud },
    { label: "已下载", value: formatBytes(downloadedBytes), icon: Download },
    { label: "进度", value: formatPercent(progress), icon: Gauge, progress },
  ];

  return (
    <TransferPageGrid>
      <StatusPanel>
        {statusPanelView === "details" ? (
          <>
            <StatusPanelHeader
              title="连接详情"
              description="查看 R2 对象、连接码、下载链接和传输进度。"
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
              title="R2 传输状态"
              description="通过 Cloudflare R2 S3 API 上传和下载临时文件。"
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
                description="上传到 R2 并复制连接码"
                icon={UploadCloud}
                onClick={() => setMode("send")}
              />
              <RoleOption
                title="接收文件"
                description="粘贴连接码并从 R2 拉取"
                icon={Download}
                onClick={() => {
                  credentialRequestRef.current += 1;
                  setSelectedFile(null);
                  setCredentials(null);
                  setIsRequestingCredentials(false);
                  setObjectKey("");
                  setConnectionCode("");
                  setMode("receive");
                }}
              />
            </div>
          )}

          {mode === "send" && (
            <div className="grid gap-4">
              <div className="rounded-xl border border-[#d7e5f6] bg-[#f7fbff] px-4 py-3 text-sm text-[#365a88]">
                <strong className="block text-[#233d64]">服务端对象 Key</strong>
                <span className="mt-1 block truncate font-mono text-xs" title={objectKey}>{objectKey || (isRequestingCredentials ? "正在申请..." : "选择文件后生成")}</span>
              </div>
              <TextArea
                label={`发送方 R2 连接码 ${codeSize}`}
                value={connectionCode}
                onChange={setConnectionCode}
                placeholder="上传完成后，把这一整串连接码复制给接收方"
                readOnly
              />
              <div className="flex flex-wrap gap-3">
                <PrimaryButton onClick={() => void uploadSelectedFile()} disabled={!selectedFile || !credentials || isUploading || isRequestingCredentials}>
                  <UploadCloud aria-hidden="true" size={17} />
                  上传到 R2
                </PrimaryButton>
                <SecondaryButton onClick={() => void copyText(connectionCode).catch((error) => setSenderError(error.message))} disabled={!connectionCode}>
                  <Copy aria-hidden="true" size={17} />
                  复制连接码
                </SecondaryButton>
              </div>
              <StatusMessage message={senderError || senderStatus} tone={senderError ? "error" : "info"} />
            </div>
          )}

          {mode === "receive" && (
            <div className="grid gap-4">
              <TextArea
                label="发送方 R2 连接码"
                value={receiverCodeInput}
                onChange={setReceiverCodeInput}
                placeholder="把发送方复制出来的 R2 连接码粘贴到这里"
              />
              <div className="flex flex-wrap gap-3">
                <SecondaryButton onClick={() => void parseReceiverCode()} disabled={!receiverCodeInput.trim()}>
                  <FileText aria-hidden="true" size={17} />
                  读取连接码
                </SecondaryButton>
                <PrimaryButton onClick={() => void downloadFromR2()} disabled={isDownloading || (!incomingCode && !receiverCodeInput.trim())}>
                  <Download aria-hidden="true" size={17} />
                  下载文件
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
            ariaLabel={mode === "send" ? "选择上传文件" : "文件选择状态"}
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
                ? "粘贴连接码后从 Cloudflare R2 下载"
                : mode === "send"
                  ? selectedFile
                    ? formatBytes(selectedFile.size)
                    : "选择文件后上传到 Cloudflare R2"
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
          title="已下载文件"
          countLabel={`${receivedFiles.length} 个文件`}
          ariaLabel="已下载文件列表"
          emptyText="下载完成后，文件会出现在这里并自动触发下载。"
          files={receivedFiles}
          formatSize={formatBytes}
          onDownload={saveBlob}
        />
      </FilesPanel>
    </TransferPageGrid>
  );
}
