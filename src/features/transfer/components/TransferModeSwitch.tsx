import { Download, UploadCloud } from "lucide-react";
import { useRef } from "react";
import type { KeyboardEvent, Ref } from "react";

export type TransferDirection = "upload" | "download";

export function TransferModeSwitch({
  mode,
  onChange,
}: {
  mode: TransferDirection;
  onChange: (mode: TransferDirection) => void;
}) {
  const uploadRef = useRef<HTMLButtonElement>(null);
  const downloadRef = useRef<HTMLButtonElement>(null);

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, direction: TransferDirection) => {
    let next: TransferDirection;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight":
        next = direction === "upload" ? "download" : "upload";
        break;
      case "Home":
        next = "upload";
        break;
      case "End":
        next = "download";
        break;
      default:
        return;
    }

    event.preventDefault();
    // Activate with Enter/Space so exploring tabs never cancels a transfer.
    (next === "upload" ? uploadRef : downloadRef).current?.focus();
  };

  return (
    <div className="home-transfer-mode transfer-mode-switch" aria-label="选择操作" role="tablist">
      <ModeButton
        active={mode === "upload"}
        description="创建取件码"
        icon={UploadCloud}
        label="上传文件"
        direction="upload"
        buttonRef={uploadRef}
        onClick={() => onChange("upload")}
        onKeyDown={(event) => moveFocus(event, "upload")}
        testId="transfer-mode-upload"
      />
      <ModeButton
        active={mode === "download"}
        description="输入取件码"
        icon={Download}
        label="下载文件"
        direction="download"
        buttonRef={downloadRef}
        onClick={() => onChange("download")}
        onKeyDown={(event) => moveFocus(event, "download")}
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
  buttonRef,
  description,
  direction,
  icon: Icon,
  label,
  onClick,
  onKeyDown,
  testId,
}: {
  active: boolean;
  buttonRef: Ref<HTMLButtonElement>;
  description: string;
  direction: TransferDirection;
  icon: typeof UploadCloud;
  label: string;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  testId: string;
}) {
  return (
    <button
      ref={buttonRef}
      className="transfer-mode-switch__button"
      type="button"
      aria-controls="transfer-panel"
      aria-selected={active}
      id={`transfer-tab-${direction}`}
      role="tab"
      tabIndex={active ? 0 : -1}
      data-testid={testId}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <Icon aria-hidden="true" size={18} />
      <span className="min-w-0 text-left">
        <strong className="block truncate text-sm font-semibold">{label}</strong>
        <small className="mt-0.5 hidden truncate text-xs font-semibold sm:block">{description}</small>
      </span>
    </button>
  );
}
