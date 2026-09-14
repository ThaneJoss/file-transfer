import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";

import { Panel } from "../../component/Panel";
import { useAuth } from "../../lib/auth/AuthProvider";
import { DownloadPanel } from "./components/DownloadPanel";
import { TransferHero } from "./components/TransferHero";
import { TransferModeSwitch } from "./components/TransferModeSwitch";
import type { TransferDirection } from "./components/TransferModeSwitch";
import { UploadLoginRequired, UploadPanel } from "./components/UploadPanel";
import { useFileReceiver } from "./hooks/useFileReceiver";
import { useFileSender } from "./hooks/useFileSender";

export function FileTransferPage() {
  const { session, isPending, sessionError } = useAuth();
  const [searchParams] = useSearchParams();
  const initialCode = searchParams.get("code") ?? "";
  const [mode, setMode] = useState<TransferDirection>(
    () => /^\d{8}$/.test(initialCode) ? "download" : "upload",
  );
  const sender = useFileSender();
  const receiver = useFileReceiver({
    allowGuest: !isPending && !session?.user,
    initialCode,
  });

  useEffect(() => {
    if (isPending || session?.user) return;
    if (sender.busy) sender.cancel();
  }, [isPending, sender.busy, sender.cancel, session?.user]);

  const switchMode = (nextMode: TransferDirection) => {
    if (nextMode === mode) return;
    if (sender.busy) sender.cancel();
    if (receiver.busy) receiver.cancel();
    setMode(nextMode);
  };

  return (
    <div
      className="home-transfer-page transfer-layout"
      data-testid="unified-transfer-page"
    >
      <TransferHero />

      <section className="transfer-workspace" aria-label="文件传输工作台">
        <TransferModeSwitch mode={mode} onChange={switchMode} />
        <div
          aria-labelledby={`transfer-tab-${mode}`}
          id={`transfer-panel-${mode}`}
          role="tabpanel"
        >
          {isPending
            ? <TransferLoading />
            : mode === "upload"
              ? session?.user
                ? <UploadPanel sender={sender} />
                : <UploadLoginRequired sessionError={sessionError} />
              : <DownloadPanel receiver={receiver} guest={!session?.user} />}
        </div>
        <p className="workspace-footnote">
          <span aria-hidden="true" />
          文件正文由选定线路传输，完成前执行完整性校验
        </p>
      </section>
    </div>
  );
}

function TransferLoading() {
  return (
    <Panel className="transfer-loading" testId="transfer-loading">
      <span className="transfer-loading__icon">
        <LoaderCircle className="animate-spin" aria-hidden="true" size={24} />
      </span>
      <div>
        <strong className="block text-sm font-semibold text-ink">正在建立安全会话</strong>
        <p className="mt-1 text-xs text-muted" role="status">正在确认登录状态...</p>
      </div>
    </Panel>
  );
}
