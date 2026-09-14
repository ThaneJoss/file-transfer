import {
  CheckCircle2,
  Download,
  FileCheck2,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";

import { Panel } from "../../../component/Panel";
import { PrimaryButton, SecondaryButton } from "../../../component/TransferControls";
import { formatBytes } from "../../../lib/files/format";
import type { FileReceiverController } from "../hooks/useFileReceiver";
import {
  InlineStatus,
  IntegrityBadge,
  ProgressCard,
  RouteDiagnostics,
} from "./TransferFeedback";

export function DownloadPanel({
  receiver,
  guest,
}: {
  receiver: FileReceiverController;
  guest: boolean;
}) {
  return (
    <Panel className="home-transfer-panel transfer-panel" testId="download-panel">
      <header className="transfer-panel__header">
        <div>
          <span className="panel-kicker">01 · Enter pickup code</span>
          <h2 className="mt-1.5 text-xl font-semibold text-ink sm:text-2xl">下载文件</h2>
          <p className="mt-1 text-xs leading-5 text-muted sm:text-sm">
            输入取件码，自动完成连接、测速与校验。
          </p>
        </div>
        <span className="panel-state">
          <span />
          {receiver.busy ? "接收中" : "接收端就绪"}
        </span>
      </header>

      {guest && (
        <p className="guest-access-note">
          <ShieldCheck aria-hidden="true" size={15} />
          访客接收已启用，无需注册账号。
        </p>
      )}

      <label className="pickup-input">
        <span className="pickup-input__label">
          <span>8 位取件码</span>
          <small>NUMERIC ACCESS KEY</small>
        </span>
        <span className="pickup-input__field">
          <KeyRound aria-hidden="true" size={19} />
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            placeholder="00000000"
            value={receiver.code}
            disabled={receiver.busy}
            onChange={(event) => receiver.setCode(event.target.value)}
            data-testid="receiver-code"
          />
          <span>{receiver.code.length} / 8</span>
        </span>
      </label>

      {receiver.descriptor && (
        <div className="receiver-file" data-testid="receiver-file">
          <span className="receiver-file__icon">
            <FileCheck2 aria-hidden="true" size={22} />
          </span>
          <div className="min-w-0">
            <span className="block text-xs font-normal text-muted uppercase">
              Incoming file
            </span>
            <strong className="mt-1 block truncate text-sm font-semibold text-ink" title={receiver.descriptor.name}>
              {receiver.descriptor.name}
            </strong>
            <span className="mt-1 block text-xs text-muted">{formatBytes(receiver.descriptor.size)}</span>
          </div>
          <IntegrityBadge legacy={!receiver.descriptor.sha256} />
        </div>
      )}

      {receiver.phase === "receiving" && (
        <ProgressCard
          label={`已接收 ${formatBytes(receiver.downloadedBytes)}`}
          progress={receiver.progress}
          testId="download-progress"
        />
      )}

      {receiver.phase === "complete" && (
        <div className="download-complete" data-testid="download-complete">
          <span className="download-complete__icon">
            <CheckCircle2 aria-hidden="true" size={24} />
          </span>
          <div className="min-w-0">
            <strong className="text-sm font-semibold text-ink">文件已安全保存</strong>
            <p className="mt-1 truncate text-xs text-muted">保存位置：{receiver.savedTo || "浏览器下载"}</p>
            {receiver.winner && (
              <p className="mt-1 text-xs font-normal text-positive">
                最快线路：{receiver.winner.toUpperCase()}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="transfer-actions">
        {receiver.phase !== "complete" && (
          <PrimaryButton
            onClick={() => void receiver.receive()}
            disabled={receiver.code.length !== 8 || receiver.busy || receiver.metadataPending || !receiver.readyToReceive}
          >
            <Download aria-hidden="true" size={16} />
            {receiver.busy ? "接收中..." : receiver.metadataPending ? "正在读取..." : "开始接收"}
          </PrimaryButton>
        )}
        {receiver.busy && (
          <SecondaryButton onClick={receiver.cancel}>
            <X aria-hidden="true" size={16} />
            取消
          </SecondaryButton>
        )}
        {(receiver.descriptor || receiver.phase === "complete" || receiver.phase === "error") && !receiver.busy && (
          <SecondaryButton onClick={receiver.reset}>
            <RefreshCw aria-hidden="true" size={16} />
            输入其他取件码
          </SecondaryButton>
        )}
      </div>

      <RouteDiagnostics routes={receiver.routes} supportId={receiver.supportId} />
      <InlineStatus status={receiver.status} error={receiver.error} />
    </Panel>
  );
}
