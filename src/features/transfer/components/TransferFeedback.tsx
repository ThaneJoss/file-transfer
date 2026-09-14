import { AlertCircle, CheckCircle2, ChevronDown, Info, LoaderCircle } from "lucide-react";

import { formatPercent } from "../../../lib/files/format";
import type { RouteStates } from "../services/multipathTransfer";

const stateLabels: Record<string, string> = {
  preparing: "准备中",
  ready: "已就绪",
  probing: "测速中",
  selected: "已选择",
  transferring: "传输中",
  complete: "已完成",
  failed: "不可用",
};

export function RouteDiagnostics({
  routes,
  supportId,
}: {
  routes: RouteStates;
  supportId: string;
}) {
  const entries = Object.entries(routes);
  if (!entries.length && !supportId) return null;

  return (
    <details className="route-diagnostics" data-testid="route-diagnostics">
      <summary>
        <span className="flex min-w-0 items-center gap-2">
          <span className="route-diagnostics__signal" aria-hidden="true" />
          <span className="truncate">线路遥测与故障编号</span>
        </span>
        <ChevronDown className="route-diagnostics__chevron" aria-hidden="true" size={16} />
      </summary>
      <div className="route-diagnostics__body">
        {entries.length > 0 && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {entries.map(([route, state]) => (
              <span className="route-chip" data-state={state} key={route}>
                <i aria-hidden="true" />
                <strong>{route.toUpperCase()}</strong>
                <small>{stateLabels[state] ?? state}</small>
              </span>
            ))}
          </div>
        )}
        {supportId && (
          <p className="mt-3 break-all font-mono text-xs leading-5 text-muted">
            SUPPORT ID · {supportId}
          </p>
        )}
      </div>
    </details>
  );
}

export function ProgressCard({
  label,
  progress,
  testId,
}: {
  label: string;
  progress: number;
  testId: string;
}) {
  const normalized = Math.max(0, Math.min(100, progress));
  return (
    <div className="progress-card" data-testid={testId}>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="flex min-w-0 items-center gap-2 font-bold text-muted">
          <LoaderCircle className="animate-spin text-primary" aria-hidden="true" size={14} />
          <span className="truncate">{label}</span>
        </span>
        <strong className="font-mono text-primary">{formatPercent(normalized)}</strong>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(normalized)}
      >
        <span style={{ width: `${normalized}%` }} />
      </div>
    </div>
  );
}

export function InlineStatus({
  status,
  error,
}: {
  status: string;
  error: string;
}) {
  const Icon = error ? AlertCircle : Info;
  return (
    <p
      className="inline-status"
      data-tone={error ? "error" : "info"}
      role={error ? "alert" : "status"}
      aria-live={error ? "assertive" : "polite"}
    >
      <Icon aria-hidden="true" size={15} />
      <span>{error || status}</span>
    </p>
  );
}

export function IntegrityBadge({ legacy = false }: { legacy?: boolean }) {
  return (
    <span className="integrity-badge">
      <CheckCircle2 aria-hidden="true" size={14} />
      {legacy ? "旧协议：仅校验文件大小" : "完成前校验 SHA-256"}
    </span>
  );
}
