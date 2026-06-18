import { Download, FileText, HardDrive, UploadCloud } from "lucide-react";
import type { ChangeEvent, DragEvent, ReactNode, RefObject } from "react";
import type { LucideIcon } from "lucide-react";

import { Panel } from "../component/Panel";
import { PrimaryButton } from "../component/TransferControls";

export type TransferStepItem = {
  label: string;
  meta: string;
  icon: LucideIcon;
  active: boolean;
  connectorActive?: boolean;
};

export type MetricItem = {
  label: string;
  value: string;
  icon: LucideIcon;
  active?: boolean;
  progress?: number;
};

type TransferFileItem = {
  id: string;
  name: string;
  size: number;
  receivedAt: string;
};

export function TransferPageGrid({ children }: { children: ReactNode }) {
  return (
    <div
      className="transfer-page-grid"
      data-testid="transfer-page-root"
    >
      {children}
    </div>
  );
}

export function StatusPanel({ children }: { children: ReactNode }) {
  return (
    <Panel className="transfer-panel transfer-status-panel" testId="status-panel">
      <div className="transfer-panel-body transfer-status-panel-body">{children}</div>
    </Panel>
  );
}

export function MainPanelGrid({ children }: { children: ReactNode }) {
  return (
    <div className="transfer-main-panel-grid">
      {children}
    </div>
  );
}

export function ActionPanel({ children }: { children: ReactNode }) {
  return (
    <Panel className="transfer-panel transfer-action-panel" testId="target-panel">
      <div className="transfer-panel-body">{children}</div>
    </Panel>
  );
}

export function UploadPanel({ children }: { children: ReactNode }) {
  return (
    <Panel className="transfer-panel transfer-upload-panel" testId="upload-panel">
      {children}
    </Panel>
  );
}

export function FilesPanel({ children }: { children: ReactNode }) {
  return (
    <Panel className="transfer-panel transfer-files-panel" testId="file-list-panel">
      <div className="transfer-panel-body">{children}</div>
    </Panel>
  );
}

export function TransferSteps({ steps }: { steps: TransferStepItem[] }) {
  return (
    <div className="relative grid shrink-0 grid-cols-4 items-start max-[620px]:grid-cols-1 max-[620px]:gap-5">
      <div className="absolute left-[12.5%] right-[12.5%] top-[26px] grid grid-cols-3 max-[620px]:hidden">
        {steps.slice(0, -1).map((step) => (
          <span
            className={`mx-7 h-[3px] rounded-full ${step.connectorActive ?? step.active ? "bg-[#1677ff]" : "bg-[#cdd8e7]"}`}
            key={`connector-${step.label}`}
          />
        ))}
      </div>
      {steps.map((step) => {
        const Icon = step.icon;
        return (
          <div className="relative z-10 grid min-w-0 justify-items-center text-center max-[620px]:grid-cols-[56px_1fr] max-[620px]:justify-items-start max-[620px]:gap-3 max-[620px]:text-left" key={step.label}>
            <span
              className={`grid size-[54px] place-items-center rounded-2xl text-white shadow-[0_10px_25px_rgba(47,125,246,0.25)] ${
                step.active ? "bg-[#1677ff]" : "bg-[#aeb8c8]"
              }`}
            >
              <Icon aria-hidden="true" size={25} />
            </span>
            <div className="min-w-0">
              <strong className="mt-4 block truncate text-[15px] font-extrabold text-[#071b3a] max-[620px]:mt-1">
                {step.label}
              </strong>
              <span className="mt-2 block truncate text-sm text-[#667a9a] max-[620px]:mt-0">{step.meta}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function MetricGrid({ items }: { items: MetricItem[] }) {
  return (
    <div className="grid shrink-0 grid-cols-2 gap-2.5 max-[560px]:grid-cols-1">
      {items.map((item) => (
        <MetricCard item={item} key={item.label} />
      ))}
    </div>
  );
}

export function ConnectionDetails({
  items,
  primaryCount = 4,
  expanded = false,
  showHeading = true,
  onShowMore,
}: {
  items: MetricItem[];
  primaryCount?: number;
  expanded?: boolean;
  showHeading?: boolean;
  onShowMore?: () => void;
}) {
  const visibleItems = expanded ? items : items.slice(0, primaryCount);
  const hasMoreItems = items.length > primaryCount;

  return (
    <section className={`connection-details ${expanded ? "connection-details-expanded" : ""}`}>
      {showHeading && <h2 className="mb-3 shrink-0 text-[22px] font-extrabold text-[#061b3a]">连接详情</h2>}
      <MetricGrid items={visibleItems} />
      {!expanded && hasMoreItems && onShowMore && (
        <button className="connection-details-more" type="button" onClick={onShowMore}>
          更多详情
        </button>
      )}
    </section>
  );
}

function MetricCard({ item }: { item: MetricItem }) {
  const Icon = item.icon;
  return (
    <div className="grid min-h-[62px] min-w-0 grid-cols-[30px_minmax(0,1fr)] items-center gap-2.5 rounded-xl border border-[#dfeaf7] bg-white/65 px-3 py-2.5 text-[13px] shadow-[0_6px_16px_rgba(16,34,59,0.025)]">
      <span className="grid size-[30px] place-items-center rounded-lg bg-[#eef6ff] text-[#1677ff]">
        <Icon aria-hidden="true" size={16} />
      </span>
      {item.progress == null ? (
        <span className="min-w-0">
          <span className="block min-w-0 truncate text-[#6a7f9e]" title={item.label}>{item.label}</span>
          <strong className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[14px] font-extrabold text-[#142a4f]">
            {item.active && <span className="inline-block size-2 shrink-0 rounded-full bg-[#1dc85f]" />}
            <span className="min-w-0 truncate" title={item.value}>{item.value}</span>
          </strong>
        </span>
      ) : (
        <span className="grid min-w-0 gap-1.5">
          <span className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[#6a7f9e]" title={item.label}>{item.label}</span>
            <strong className="shrink-0 text-[14px] font-extrabold text-[#142a4f]" title={item.value}>{item.value}</strong>
          </span>
          <span className="h-1.5 rounded-full bg-[#dce8f7]">
            <span className="block h-full rounded-full bg-[#1677ff]" style={{ width: `${item.progress}%` }} />
          </span>
        </span>
      )}
    </div>
  );
}

export function RoleOption({
  title,
  description,
  icon: Icon,
  selected = false,
  onClick,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`grid min-h-[68px] grid-cols-[22px_34px_minmax(0,1fr)] items-center gap-3 rounded-xl border px-3 text-left transition hover:-translate-y-px hover:border-[#1677ff] hover:bg-white ${
        selected ? "border-[#9ec7ff] bg-[#f2f8ff] shadow-[0_8px_22px_rgba(47,125,246,0.10)]" : "border-[#d7e5f6] bg-white/80"
      }`}
      type="button"
      onClick={onClick}
    >
      <span className={`size-4 rounded-full border ${selected ? "border-[#1677ff] bg-[#1677ff] ring-4 ring-[#1677ff]/15" : "border-[#9aabc4]"}`} />
      <Icon aria-hidden="true" className={selected ? "text-[#1677ff]" : "text-[#6e82a0]"} size={23} />
      <span className="min-w-0">
        <strong className="block text-[15px] font-extrabold text-[#071b3a]">{title}</strong>
        <span className="block truncate text-[13px] text-[#526c92]">{description}</span>
      </span>
    </button>
  );
}

export function FilePickerPanel({
  inputRef,
  onFileInput,
  onDrop,
  ariaLabel,
  title,
  titleFallback,
  subtitle,
  onSelect,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  onFileInput: (event: ChangeEvent<HTMLInputElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  ariaLabel: string;
  title?: string;
  titleFallback: string;
  subtitle: string;
  onSelect: () => void;
}) {
  return (
    <div
      className="file-picker-panel"
      onDrop={onDrop}
      onDragOver={(event) => event.preventDefault()}
      aria-label={ariaLabel}
      data-testid="file-upload-dropzone"
    >
      <input ref={inputRef} className="hidden" type="file" onChange={onFileInput} />
      <div className="mb-4 grid size-[clamp(64px,7.5dvh,82px)] place-items-center rounded-3xl bg-[#1677ff] text-white shadow-[0_16px_32px_rgba(47,125,246,0.28)] max-[1180px]:size-[82px]">
        <UploadCloud aria-hidden="true" size={46} />
      </div>
      <strong
        className="block h-[30px] w-full max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[20px] font-extrabold leading-[30px] text-[#071b3a]"
        title={title}
      >
        {title || titleFallback}
      </strong>
      <span className="mt-1 text-[14px] text-[#526c92]">{subtitle}</span>
      <div className="mt-5 flex flex-wrap justify-center gap-3">
        <PrimaryButton onClick={onSelect}>
          <HardDrive aria-hidden="true" size={17} />
          选择文件
        </PrimaryButton>
      </div>
    </div>
  );
}

export function ReceivedFilesPanel<TFile extends TransferFileItem>({
  title,
  countLabel,
  ariaLabel,
  emptyText,
  files,
  formatSize,
  onDownload,
}: {
  title: string;
  countLabel: string;
  ariaLabel: string;
  emptyText: string;
  files: TFile[];
  formatSize: (bytes: number) => string;
  onDownload: (file: TFile) => void;
}) {
  return (
    <>
      <div className="mb-4 flex shrink-0 items-center justify-between gap-4 max-[560px]:items-start max-[560px]:flex-col">
        <h2 className="m-0 text-[26px] font-extrabold text-[#061b3a]">{title}</h2>
        <span className="rounded-lg border border-[#d7e5f6] bg-white px-4 py-2 text-[15px] font-medium text-[#526c92]">
          {countLabel}
        </span>
      </div>

      <div className={`grid min-h-0 gap-3 ${files.length > 0 ? "overflow-auto pr-1" : "overflow-hidden"}`} role="table" aria-label={ariaLabel}>
        {files.length === 0 ? (
          <div className="grid min-h-[108px] place-items-center rounded-xl border border-dashed border-[#c7daf2] bg-white/70 text-[15px] text-[#607a9f]">
            {emptyText}
          </div>
        ) : (
          files.map((file) => (
            <article
              className="grid min-h-[72px] grid-cols-[minmax(180px,1.8fr)_minmax(92px,0.55fr)_minmax(170px,0.9fr)_minmax(124px,0.5fr)] items-center gap-4 rounded-xl border border-[#e0eaf7] bg-white px-4 text-[15px] text-[#355176] shadow-[0_8px_22px_rgba(16,34,59,0.035)] max-[900px]:grid-cols-1 max-[900px]:gap-2.5 max-[900px]:p-4"
              key={file.id}
              role="row"
            >
              <div className="flex min-w-0 items-center gap-3 text-[#071b3a]" role="cell">
                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-[#20c263] text-white shadow-sm">
                  <FileText aria-hidden="true" size={17} />
                </span>
                <strong className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[16px] font-extrabold">{file.name}</strong>
              </div>
              <span role="cell">{formatSize(file.size)}</span>
              <time role="cell">{file.receivedAt}</time>
              <button
                className="inline-flex min-h-[34px] items-center justify-center gap-1.5 rounded-lg border border-[#d7e5f6] bg-white px-3 text-[15px] font-extrabold text-[#1677ff] transition hover:border-[#9ec7ff]"
                type="button"
                onClick={() => onDownload(file)}
              >
                <Download aria-hidden="true" size={17} />
                下载
              </button>
            </article>
          ))
        )}
      </div>
    </>
  );
}
