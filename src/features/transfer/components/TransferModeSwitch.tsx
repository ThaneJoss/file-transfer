import { Download, UploadCloud } from "lucide-react";

export type TransferDirection = "upload" | "download";

export function TransferModeSwitch({
  mode,
  onChange,
}: {
  mode: TransferDirection;
  onChange: (mode: TransferDirection) => void;
}) {
  return (
    <div className="home-transfer-mode transfer-mode-switch" aria-label="选择操作" role="tablist">
      <ModeButton
        active={mode === "upload"}
        description="创建取件码"
        icon={UploadCloud}
        label="上传文件"
        onClick={() => onChange("upload")}
        testId="transfer-mode-upload"
      />
      <ModeButton
        active={mode === "download"}
        description="输入取件码"
        icon={Download}
        label="下载文件"
        onClick={() => onChange("download")}
        testId="transfer-mode-download"
      />
      <span
        className="transfer-mode-switch__indicator"
        data-mode={mode}
        aria-hidden="true"
      />
    </div>
  );
}

function ModeButton({
  active,
  description,
  icon: Icon,
  label,
  onClick,
  testId,
}: {
  active: boolean;
  description: string;
  icon: typeof UploadCloud;
  label: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      className="transfer-mode-switch__button"
      type="button"
      aria-controls={`transfer-panel-${testId === "transfer-mode-upload" ? "upload" : "download"}`}
      aria-selected={active}
      id={`transfer-tab-${testId === "transfer-mode-upload" ? "upload" : "download"}`}
      role="tab"
      data-testid={testId}
      onClick={onClick}
    >
      <Icon aria-hidden="true" size={18} />
      <span className="min-w-0 text-left">
        <strong className="block truncate text-sm font-semibold">{label}</strong>
        <small className="mt-0.5 hidden truncate text-xs font-semibold sm:block">{description}</small>
      </span>
    </button>
  );
}
