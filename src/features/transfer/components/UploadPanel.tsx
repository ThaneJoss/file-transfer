import {
  CheckCircle2,
  Copy,
  FileCheck2,
  Gauge,
  HardDrive,
  LogIn,
  RefreshCw,
  Rocket,
  ShieldCheck,
  UploadCloud,
  X,
  Zap,
} from "lucide-react";
import { useRef, useState } from "react";
import type { DragEvent } from "react";
import { Link } from "react-router";

import { Panel } from "../../../component/Panel";
import { PrimaryButton, SecondaryButton } from "../../../component/TransferControls";
import { copyText } from "../../../lib/browser/clipboard";
import { formatBytes } from "../../../lib/files/format";
import type { FileSenderController } from "../hooks/useFileSender";
import { InlineStatus, ProgressCard, RouteDiagnostics } from "./TransferFeedback";

export function UploadLoginRequired({ sessionError }: { sessionError: string }) {
  return (
    <Panel className="access-gate" testId="transfer-login-required">
      <span className="access-gate__icon">
        <ShieldCheck aria-hidden="true" size={27} />
      </span>
      <div className="relative">
        <span className="panel-kicker">Sender access</span>
        <h2 className="mt-2 text-2xl font-semibold tracking-[-0.035em] text-ink">上传文件需要登录</h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">
          使用 Passkey 保护上传额度。接收方无需账号，打开分享链接即可安全接收。
        </p>
        {sessionError && (
          <p className="error-callout mt-4" role="alert">
            {sessionError}
          </p>
        )}
      </div>
      <Link className="button-primary relative inline-flex min-h-11 items-center gap-2 px-6 text-sm font-semibold" to="/login" state={{ from: "/" }}>
        <LogIn aria-hidden="true" size={17} />
        使用 Passkey 登录
      </Link>
      <p className="relative font-mono text-xs font-bold tracking-[0.14em] text-subtle uppercase">
        Passwordless · WebAuthn
      </p>
    </Panel>
  );
}

export function UploadPanel({ sender }: { sender: FileSenderController }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [dragActive, setDragActive] = useState(false);

  const chooseFile = (file: File | null) => {
    setCopyStatus("");
    setDragActive(false);
    sender.setFile(file);
  };
  const reset = () => {
    if (inputRef.current) inputRef.current.value = "";
    setCopyStatus("");
    setDragActive(false);
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
    <Panel className="home-transfer-panel transfer-panel" testId="upload-panel">
      <header className="transfer-panel__header">
        <div>
          <span className="panel-kicker">01 · Prepare transfer</span>
          <h2 className="mt-1.5 text-xl font-semibold tracking-[-0.03em] text-ink sm:text-2xl">上传文件</h2>
          <p className="mt-1 text-xs leading-5 text-muted sm:text-sm">
            接收方加入前，不会发送文件正文。
          </p>
        </div>
        <span className="panel-state">
          <span />
          {sender.busy ? "链路处理中" : "发送端就绪"}
        </span>
      </header>

      {!sender.pickupCode && (
        <div className="home-upload-mode strategy-switch" aria-label="传输策略">
          <StrategyButton
            active={sender.mode === "auto"}
            description="测速后择优传输"
            disabled={sender.busy}
            icon={Gauge}
            label="智能模式"
            onClick={() => sender.setMode("auto")}
            testId="transfer-speed-auto"
          />
          <StrategyButton
            active={sender.mode === "turbo"}
            description="五路并发，速度优先"
            disabled={sender.busy}
            icon={Rocket}
            label="极速模式"
            onClick={() => sender.setMode("turbo")}
            testId="transfer-speed-turbo"
            tone="turbo"
          />
        </div>
      )}

      {sender.mode === "turbo" && !sender.pickupCode && (
        <p className="warning-callout">
          <Zap aria-hidden="true" size={15} />
          极速模式同时使用五条线路，会消耗更多网络流量。
        </p>
      )}

      {!sender.pickupCode && (
        <div
          className="home-upload-dropzone upload-dropzone"
          data-active={dragActive || undefined}
          data-state={sender.busy ? "busy" : sender.file ? "selected" : "idle"}
          onDragEnter={(event) => {
            event.preventDefault();
            if (!sender.busy) setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
          data-testid="upload-dropzone"
        >
          <input
            ref={inputRef}
            className="hidden"
            type="file"
            disabled={sender.busy}
            onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
          />
          <div className="home-upload-dropzone-content upload-dropzone__content">
            <span className="upload-dropzone__icon">
              {sender.file
                ? <FileCheck2 aria-hidden="true" size={28} />
                : <UploadCloud aria-hidden="true" size={28} />}
            </span>
            {sender.file ? (
              <div className="min-w-0" data-testid="selected-file">
                <strong className="block max-w-[min(65vw,420px)] truncate text-base font-semibold text-ink" title={sender.file.name}>
                  {sender.file.name}
                </strong>
                <span className="mt-1 block font-mono text-xs font-bold tracking-[0.08em] text-muted">
                  {formatBytes(sender.file.size)} · READY
                </span>
              </div>
            ) : (
              <div>
                <strong className="block text-base font-semibold text-ink">拖拽文件到这里</strong>
                <span className="mt-1 block text-xs text-muted">或从设备中选择一个文件</span>
              </div>
            )}
            {!sender.busy && (
              <SecondaryButton onClick={() => inputRef.current?.click()} className="min-h-9 px-4 text-xs">
                <HardDrive aria-hidden="true" size={15} />
                {sender.file ? "重新选择" : "选择文件"}
              </SecondaryButton>
            )}
          </div>
        </div>
      )}

      {((sender.busy && sender.phase !== "waiting") || sender.progress > 0) && (
        <ProgressCard
          label={sender.phase === "transferring" ? "传输进度" : "准备进度"}
          progress={sender.progress}
          testId="upload-progress"
        />
      )}

      {sender.pickupCode && (
        <PickupCodeCard
          sender={sender}
          copyStatus={copyStatus}
          copyPickupCode={copyPickupCode}
          copyShareLink={copyShareLink}
          reset={reset}
        />
      )}

      <div className="transfer-actions">
        {!sender.pickupCode && (
          <PrimaryButton onClick={() => void sender.start()} disabled={!sender.file || sender.busy}>
            <FileCheck2 aria-hidden="true" size={16} />
            {sender.busy ? "正在准备..." : "生成取件码"}
          </PrimaryButton>
        )}
        {sender.busy && (
          <SecondaryButton onClick={sender.cancel}>
            <X aria-hidden="true" size={16} />
            取消
          </SecondaryButton>
        )}
        {!sender.busy && sender.file && !sender.pickupCode && (
          <SecondaryButton onClick={reset}>
            <RefreshCw aria-hidden="true" size={16} />
            重置
          </SecondaryButton>
        )}
      </div>

      <RouteDiagnostics routes={sender.routes} supportId={sender.supportId} />
      <InlineStatus status={sender.status} error={sender.error} />
    </Panel>
  );
}

function StrategyButton({
  active,
  description,
  disabled,
  icon: Icon,
  label,
  onClick,
  testId,
  tone = "auto",
}: {
  active: boolean;
  description: string;
  disabled: boolean;
  icon: typeof Gauge;
  label: string;
  onClick: () => void;
  testId: string;
  tone?: "auto" | "turbo";
}) {
  return (
    <button
      className="strategy-switch__button"
      data-active={active || undefined}
      data-tone={tone}
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
    >
      <span className="strategy-switch__icon">
        <Icon aria-hidden="true" size={17} />
      </span>
      <span className="min-w-0 text-left">
        <strong className="block truncate text-xs font-semibold text-ink">{label}</strong>
        <small className="mt-0.5 block truncate text-xs font-semibold text-muted">{description}</small>
      </span>
      <span className="strategy-switch__check" aria-hidden="true">
        <CheckCircle2 size={14} />
      </span>
    </button>
  );
}

function PickupCodeCard({
  sender,
  copyStatus,
  copyPickupCode,
  copyShareLink,
  reset,
}: {
  sender: FileSenderController;
  copyStatus: string;
  copyPickupCode: () => Promise<void>;
  copyShareLink: () => Promise<void>;
  reset: () => void;
}) {
  return (
    <div className="pickup-ticket" data-testid="upload-complete">
      <div className="pickup-ticket__header">
        <span className="flex items-center gap-2 text-xs font-semibold text-positive">
          {sender.phase === "complete"
            ? <CheckCircle2 aria-hidden="true" size={16} />
            : <Zap aria-hidden="true" size={16} />}
          {sender.phase === "complete" ? "传输已完成" : "等待接收方加入"}
        </span>
        <span className="font-mono text-xs font-bold tracking-[0.1em] text-muted uppercase">
          One-time pickup
        </span>
      </div>

      <div className="pickup-ticket__code">
        <span className="text-xs font-semibold tracking-[0.16em] text-muted uppercase">8 位取件码</span>
        <strong data-testid="pickup-code">{sender.pickupCode}</strong>
        <span className="text-xs text-muted">
          {sender.pickupExpiresAt
            ? `有效至 ${new Date(sender.pickupExpiresAt).toLocaleString("zh-CN")}`
            : "一小时内有效"}
        </span>
      </div>

      <p className="text-center text-xs font-bold leading-5 text-soft">
        {sender.phase === "complete"
          ? `${sender.winner?.toUpperCase() ?? "最快线路"} 已完成校验`
          : sender.phase === "preparing"
            ? "取件码可立即分享，文件校验和线路正在后台准备"
            : "请保持此页面打开，等待接收方加入"}
      </p>

      <div className="flex flex-wrap justify-center gap-2.5">
        <PrimaryButton onClick={() => void copyShareLink()}>
          <Copy aria-hidden="true" size={16} />
          复制分享链接
        </PrimaryButton>
        <SecondaryButton onClick={() => void copyPickupCode()}>
          <Copy aria-hidden="true" size={16} />
          仅复制取件码
        </SecondaryButton>
        {!sender.busy && (
          <SecondaryButton onClick={reset}>
            <RefreshCw aria-hidden="true" size={16} />
            发送另一个文件
          </SecondaryButton>
        )}
      </div>
      {copyStatus && <p className="text-center text-xs font-bold text-primary" role="status">{copyStatus}</p>}
    </div>
  );
}
