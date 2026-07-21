import {
  CheckCircle2,
  Copy,
  Download,
  FileCheck2,
  HardDrive,
  LogIn,
  RefreshCw,
  ShieldCheck,
  UploadCloud,
  Zap,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { Panel } from "../../component/Panel";
import { PrimaryButton, SecondaryButton } from "../../component/TransferControls";
import { useAuth } from "../../lib/auth/AuthProvider";
import { copyText } from "../../lib/browser/clipboard";
import { formatBytes, formatPercent } from "../../lib/files/format";
import { useFileReceiver } from "./hooks/useFileReceiver";
import { useFileSender } from "./hooks/useFileSender";
import type { RouteStates } from "./services/multipathTransfer";

type Mode = "upload" | "download";

export function FileTransferPage() {
  const { session, isPending, sessionError } = useAuth();
  const [searchParams] = useSearchParams();
  const initialCode = searchParams.get("code") ?? "";
  const [mode, setMode] = useState<Mode>(() => /^\d{8}$/.test(initialCode) ? "download" : "upload");
  const sender = useFileSender();
  const receiver = useFileReceiver({ allowGuest: !isPending && !session?.user, initialCode });

  useEffect(() => {
    if (isPending || session?.user) return;
    if (sender.busy) sender.cancel();
  }, [isPending, sender.busy, sender.cancel, session?.user]);

  if (isPending) {
    return (
      <Panel className="mx-auto grid min-h-[260px] w-full max-w-3xl place-items-center p-8" testId="transfer-loading">
        <p className="text-sm font-bold text-[#526c92]" role="status">正在确认登录状态...</p>
      </Panel>
    );
  }

  const switchMode = (nextMode: Mode) => {
    if (nextMode === mode) return;
    if (sender.busy) sender.cancel();
    if (receiver.busy) receiver.cancel();
    setMode(nextMode);
  };

  return (
    <div className="home-transfer-page mx-auto grid w-full max-w-5xl gap-5 pb-6" data-testid="unified-transfer-page">
      <section className="home-transfer-hero grid gap-4 rounded-2xl border border-[#d7e5f6] bg-gradient-to-br from-white to-[#edf6ff] p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-7">
        <div>
          <h1 className="home-transfer-title text-[clamp(24px,4vw,34px)] font-black tracking-[-0.025em] text-[#061b3a]">传文件，只需要一个取件码</h1>
          <p className="home-transfer-subtitle mt-2 max-w-2xl text-sm leading-6 text-[#526c92] sm:text-base">
            选择文件先生成 8 位取件码；对方输入后自动测速并开始传输，完成时校验文件大小和 SHA-256。
          </p>
        </div>
        <span className="hidden size-16 place-items-center rounded-2xl bg-[#1677ff] text-white sm:grid">
          <FileCheck2 aria-hidden="true" size={32} />
        </span>
      </section>

      <div className="home-transfer-mode grid grid-cols-2 rounded-xl border border-[#d7e5f6] bg-white p-1.5" aria-label="选择操作">
        <ModeButton active={mode === "upload"} icon={UploadCloud} label="上传文件" onClick={() => switchMode("upload")} testId="transfer-mode-upload" />
        <ModeButton active={mode === "download"} icon={Download} label="下载文件" onClick={() => switchMode("download")} testId="transfer-mode-download" />
      </div>

      {mode === "upload"
        ? session?.user
          ? <UploadView sender={sender} />
          : <UploadLoginRequired sessionError={sessionError} />
        : <DownloadView receiver={receiver} guest={!session?.user} />}
    </div>
  );
}

function UploadLoginRequired({ sessionError }: { sessionError: string }) {
  return (
    <Panel className="p-7 sm:p-9" testId="transfer-login-required">
      <div className="grid justify-items-center gap-5 text-center">
        <span className="grid size-16 place-items-center rounded-2xl bg-[#eaf2ff] text-[#1677ff]">
          <ShieldCheck aria-hidden="true" size={32} />
        </span>
        <div>
          <h2 className="text-2xl font-black text-[#061b3a]">上传文件需要登录</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-[#526c92]">
            Passkey 用于保护上传额度；接收方无需注册，打开分享链接即可下载。
          </p>
          {sessionError && <p className="mt-3 text-sm font-bold text-[#b4232b]" role="alert">{sessionError}</p>}
        </div>
        <Link
          className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[#1677ff] px-6 text-sm font-extrabold text-white hover:bg-[#0d63da]"
          to="/login"
          state={{ from: "/" }}
        >
          <LogIn aria-hidden="true" size={18} />
          使用 Passkey 登录
        </Link>
      </div>
    </Panel>
  );
}

function ModeButton({
  active,
  icon: Icon,
  label,
  onClick,
  testId,
}: {
  active: boolean;
  icon: typeof UploadCloud;
  label: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-lg px-4 text-sm font-extrabold transition-colors ${
        active ? "bg-[#1677ff] text-white" : "text-[#526c92] hover:bg-[#edf6ff] hover:text-[#1677ff]"
      }`}
      type="button"
      aria-pressed={active}
      data-testid={testId}
      onClick={onClick}
    >
      <Icon aria-hidden="true" size={19} />
      {label}
    </button>
  );
}

function UploadView({ sender }: { sender: ReturnType<typeof useFileSender> }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [copyStatus, setCopyStatus] = useState("");

  const chooseFile = (file: File | null) => {
    setCopyStatus("");
    sender.setFile(file);
  };
  const reset = () => {
    if (inputRef.current) inputRef.current.value = "";
    setCopyStatus("");
    sender.reset();
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!sender.busy) chooseFile(event.dataTransfer.files?.[0] ?? null);
  };
  const copyPickupCode = async () => {
    try {
      await copyText(sender.pickupCode);
      setCopyStatus("取件码已复制。");
    } catch (error) {
      setCopyStatus(error instanceof Error ? error.message : "复制失败。");
    }
  };
  const copyShareLink = async () => {
    try {
      await copyText(sender.shareUrl);
      setCopyStatus("分享链接已复制。接收方无需登录。");
    } catch (error) {
      setCopyStatus(error instanceof Error ? error.message : "复制失败。");
    }
  };

  return (
    <Panel className="home-transfer-panel grid gap-5 p-5 sm:p-7" testId="upload-panel">
      <div>
        <h2 className="text-2xl font-black text-[#061b3a]">上传文件</h2>
        <p className="mt-1 text-sm text-[#526c92]">选择文件并生成取件码；接收方加入前不会发送文件正文。</p>
      </div>

      {!sender.pickupCode && (
        <div className="home-upload-mode grid grid-cols-2 gap-2 rounded-xl bg-[#edf3fb] p-1.5" aria-label="传输模式">
          <button
            className={`rounded-lg px-3 py-3 text-sm font-extrabold ${sender.mode === "auto" ? "bg-white text-[#1677ff] shadow-sm" : "text-[#526c92]"}`}
            type="button"
            aria-pressed={sender.mode === "auto"}
            disabled={sender.busy}
            onClick={() => sender.setMode("auto")}
            data-testid="transfer-speed-auto"
          >
            智能模式
            <span className="mt-0.5 block text-xs font-medium">实测后选择最快线路</span>
          </button>
          <button
            className={`rounded-lg px-3 py-3 text-sm font-extrabold ${sender.mode === "turbo" ? "bg-white text-[#d85c00] shadow-sm" : "text-[#526c92]"}`}
            type="button"
            aria-pressed={sender.mode === "turbo"}
            disabled={sender.busy}
            onClick={() => sender.setMode("turbo")}
            data-testid="transfer-speed-turbo"
          >
            极速模式
            <span className="mt-0.5 block text-xs font-medium">五条线路同时传输</span>
          </button>
        </div>
      )}

      {sender.mode === "turbo" && !sender.pickupCode && (
        <p className="rounded-xl bg-[#fff5e8] px-4 py-3 text-sm text-[#9a4a09]">
          极速模式会同时使用五条线路，速度优先，也会消耗更多网络流量。
        </p>
      )}

      {!sender.pickupCode && (
        <div
          className={`home-upload-dropzone grid min-h-[240px] place-items-center rounded-2xl border-2 border-dashed p-6 text-center transition-colors ${
            sender.busy ? "border-[#c7d5e8] bg-[#f7f9fc]" : "border-[#b9d7ff] bg-[#f7fbff] hover:border-[#1677ff]"
          }`}
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
          data-testid="upload-dropzone"
        >
          <input
            ref={inputRef}
            className="sr-only"
            type="file"
            disabled={sender.busy}
            onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
          />
          <div className="home-upload-dropzone-content grid justify-items-center gap-4">
            <span className="grid size-16 place-items-center rounded-2xl bg-[#eaf2ff] text-[#1677ff]">
              <HardDrive aria-hidden="true" size={30} />
            </span>
            {sender.file ? (
              <div className="min-w-0" data-testid="selected-file">
                <strong className="block max-w-[min(70vw,620px)] truncate text-lg text-[#061b3a]" title={sender.file.name}>{sender.file.name}</strong>
                <span className="mt-1 block text-sm text-[#526c92]">{formatBytes(sender.file.size)}</span>
              </div>
            ) : (
              <div>
                <strong className="block text-lg text-[#061b3a]">拖拽文件到这里</strong>
                <span className="mt-1 block text-sm text-[#526c92]">也可以点击下方按钮选择</span>
              </div>
            )}
            {!sender.busy && (
              <SecondaryButton onClick={() => inputRef.current?.click()}>
                <HardDrive aria-hidden="true" size={17} />
                {sender.file ? "重新选择" : "选择文件"}
              </SecondaryButton>
            )}
          </div>
        </div>
      )}

      {((sender.busy && sender.phase !== "waiting") || sender.progress > 0) && (
        <ProgressCard label={sender.phase === "transferring" ? "传输进度" : "准备进度"} progress={sender.progress} testId="upload-progress" />
      )}

      {sender.pickupCode && (
        <div className="grid gap-5 rounded-2xl border border-[#9fd2b8] bg-[#f0fbf5] p-6 text-center" data-testid="upload-complete">
          <span className="mx-auto grid size-12 place-items-center rounded-full bg-[#23a26d] text-white">
            {sender.phase === "complete" ? <CheckCircle2 aria-hidden="true" size={26} /> : <Zap aria-hidden="true" size={26} />}
          </span>
          <div>
            <div className="text-sm font-extrabold text-[#3d6b54]">8 位取件码</div>
            <div className="mt-2 font-mono text-[clamp(34px,8vw,52px)] font-black tracking-[0.16em] text-[#073b25]" data-testid="pickup-code">
              {sender.pickupCode}
            </div>
            <p className="mt-2 text-sm text-[#47725c]">
              {sender.pickupExpiresAt ? `有效至 ${new Date(sender.pickupExpiresAt).toLocaleString("zh-CN")}` : "一小时内有效"}
            </p>
            <p className="mt-1 text-sm font-bold text-[#47725c]">
              {sender.phase === "complete"
                ? `${sender.winner?.toUpperCase() ?? "最快线路"} 已完成校验`
                : sender.phase === "preparing"
                  ? "取件码可立即分享，文件校验和线路正在后台准备"
                  : "请保持此页面打开，等待接收方加入"}
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-3">
            <PrimaryButton onClick={() => void copyShareLink()}>
              <Copy aria-hidden="true" size={17} />
              复制分享链接
            </PrimaryButton>
            <SecondaryButton onClick={() => void copyPickupCode()}>
              <Copy aria-hidden="true" size={17} />
              仅复制取件码
            </SecondaryButton>
            {!sender.busy && (
              <SecondaryButton onClick={reset}>
                <RefreshCw aria-hidden="true" size={17} />
                发送另一个文件
              </SecondaryButton>
            )}
          </div>
          {copyStatus && <p className="text-sm font-bold text-[#365a88]" role="status">{copyStatus}</p>}
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        {!sender.pickupCode && (
          <PrimaryButton onClick={() => void sender.start()} disabled={!sender.file || sender.busy}>
            <FileCheck2 aria-hidden="true" size={17} />
            {sender.busy ? "正在准备..." : "生成取件码"}
          </PrimaryButton>
        )}
        {sender.busy && (
          <SecondaryButton onClick={sender.cancel}>
            <X aria-hidden="true" size={17} />
            取消
          </SecondaryButton>
        )}
        {!sender.busy && sender.file && !sender.pickupCode && (
          <SecondaryButton onClick={reset}>
            <RefreshCw aria-hidden="true" size={17} />
            重置
          </SecondaryButton>
        )}
      </div>
      <RouteStatus routes={sender.routes} supportId={sender.supportId} />
      <InlineStatus status={sender.status} error={sender.error} />
    </Panel>
  );
}

function DownloadView({ receiver, guest }: { receiver: ReturnType<typeof useFileReceiver>; guest: boolean }) {
  return (
    <Panel className="home-transfer-panel grid gap-5 p-5 sm:p-7" testId="download-panel">
      <div>
        <h2 className="text-2xl font-black text-[#061b3a]">下载文件</h2>
        <p className="mt-1 text-sm text-[#526c92]">输入 8 位取件码，一次完成连接、测速、接收和完整性校验。</p>
        {guest && <p className="mt-2 text-xs font-bold text-[#23734c]">访客接收已启用，无需注册账号。</p>}
      </div>

      <label className="grid gap-2">
        <span className="text-sm font-extrabold text-[#233d64]">8 位取件码</span>
        <input
          className="h-16 w-full min-w-0 rounded-xl border border-[#b9d7ff] bg-[#f7fbff] px-4 text-center font-mono text-[clamp(24px,8vw,30px)] font-black tracking-[0.12em] text-[#061b3a] outline-none placeholder:text-[#a4b5cb] focus:border-[#1677ff] focus:ring-4 focus:ring-[#1677ff]/10 sm:tracking-[0.18em]"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          placeholder="00000000"
          value={receiver.code}
          disabled={receiver.busy}
          onChange={(event) => receiver.setCode(event.target.value)}
          data-testid="receiver-code"
        />
      </label>

      {receiver.descriptor && (
        <div className="grid gap-3 rounded-2xl border border-[#d7e5f6] bg-[#f7fbff] p-5" data-testid="receiver-file">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-[#eaf2ff] text-[#1677ff]">
              <FileCheck2 aria-hidden="true" size={23} />
            </span>
            <div className="min-w-0">
              <strong className="block truncate text-lg text-[#061b3a]" title={receiver.descriptor.name}>{receiver.descriptor.name}</strong>
              <span className="mt-1 block text-sm text-[#526c92]">{formatBytes(receiver.descriptor.size)}</span>
            </div>
          </div>
          <div className="inline-flex w-fit items-center gap-2 rounded-full bg-[#e8f8ef] px-3 py-1.5 text-xs font-extrabold text-[#23734c]">
            <ShieldCheck aria-hidden="true" size={15} />
            {receiver.descriptor.sha256 ? "完成前校验 SHA-256" : "旧协议：仅校验文件大小"}
          </div>
        </div>
      )}

      {receiver.phase === "receiving" && (
        <ProgressCard label={`已接收 ${formatBytes(receiver.downloadedBytes)}`} progress={receiver.progress} testId="download-progress" />
      )}

      {receiver.phase === "complete" && (
        <div className="flex items-start gap-3 rounded-2xl border border-[#9fd2b8] bg-[#f0fbf5] p-5" data-testid="download-complete">
          <CheckCircle2 aria-hidden="true" className="mt-0.5 shrink-0 text-[#23a26d]" size={24} />
          <div>
            <strong className="text-[#073b25]">文件已安全保存</strong>
            <p className="mt-1 text-sm text-[#47725c]">保存位置：{receiver.savedTo || "浏览器下载"}</p>
            {receiver.winner && <p className="mt-1 text-xs font-bold text-[#47725c]">最快线路：{receiver.winner.toUpperCase()}</p>}
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        {receiver.phase !== "complete" && (
          <PrimaryButton
            onClick={() => void receiver.receive()}
            disabled={receiver.code.length !== 8 || receiver.busy || receiver.metadataPending || !receiver.readyToReceive}
          >
            <Download aria-hidden="true" size={17} />
            {receiver.busy ? "接收中..." : receiver.metadataPending ? "正在读取..." : "开始接收"}
          </PrimaryButton>
        )}
        {receiver.busy && (
          <SecondaryButton onClick={receiver.cancel}>
            <X aria-hidden="true" size={17} />
            取消
          </SecondaryButton>
        )}
        {(receiver.descriptor || receiver.phase === "complete" || receiver.phase === "error") && !receiver.busy && (
          <SecondaryButton onClick={receiver.reset}>
            <RefreshCw aria-hidden="true" size={17} />
            输入其他取件码
          </SecondaryButton>
        )}
      </div>
      <RouteStatus routes={receiver.routes} supportId={receiver.supportId} />
      <InlineStatus status={receiver.status} error={receiver.error} />
    </Panel>
  );
}

function RouteStatus({ routes, supportId }: { routes: RouteStates; supportId: string }) {
  const entries = Object.entries(routes);
  if (!entries.length && !supportId) return null;
  const stateLabels: Record<string, string> = {
    preparing: "准备中", ready: "已就绪", probing: "测速中", selected: "已选择",
    transferring: "传输中", complete: "已完成", failed: "不可用",
  };
  return (
    <details className="rounded-xl border border-[#d7e5f6] bg-white px-4 py-3 text-sm" data-testid="route-diagnostics">
      <summary className="cursor-pointer font-extrabold text-[#365a88]">连接详情与故障编号</summary>
      <div className="mt-3 flex flex-wrap gap-2">
        {entries.map(([route, state]) => (
          <span className="rounded-full bg-[#edf6ff] px-3 py-1 text-xs font-bold text-[#365a88]" key={route}>
            {route.toUpperCase()} · {stateLabels[state] ?? state}
          </span>
        ))}
      </div>
      {supportId && <p className="mt-3 break-all font-mono text-xs text-[#6b7f9f]">故障编号：{supportId}</p>}
    </details>
  );
}

function ProgressCard({ label, progress, testId }: { label: string; progress: number; testId: string }) {
  const normalized = Math.max(0, Math.min(100, progress));
  return (
    <div className="grid gap-2 rounded-xl border border-[#d7e5f6] bg-[#f7fbff] p-4" data-testid={testId}>
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-bold text-[#526c92]">{label}</span>
        <strong className="text-[#061b3a]">{formatPercent(normalized)}</strong>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-[#dce8f7]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(normalized)}>
        <span className="block h-full rounded-full bg-[#1677ff] transition-[width]" style={{ width: `${normalized}%` }} />
      </div>
    </div>
  );
}

function InlineStatus({ status, error }: { status: string; error: string }) {
  return (
    <p
      className={`rounded-xl px-4 py-3 text-sm leading-6 ${error ? "bg-[#fff0f0] text-[#b4232b]" : "bg-[#edf6ff] text-[#365a88]"}`}
      role={error ? "alert" : "status"}
      aria-live={error ? "assertive" : "polite"}
    >
      {error || status}
    </p>
  );
}
