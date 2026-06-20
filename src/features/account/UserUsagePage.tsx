import { useState } from "react";

import { Panel } from "../../component/Panel";
import { SecondaryButton, StatusMessage } from "../../component/TransferControls";
import { useAuth } from "../../lib/auth/AuthProvider";
import type { UsagePeriod, UsageService } from "../../lib/auth/AuthProvider";
import { formatBytes, formatPercent } from "../../lib/files/format";

const serviceRows: Array<{
  service: UsageService;
  label: string;
  description: string;
}> = [
  { service: "turn", label: "TURN", description: "中继传输流量" },
  { service: "sfu", label: "SFU", description: "服务器转发流量" },
  { service: "r2", label: "R2", description: "对象存储上传/下载流量" },
];

export function UserUsagePage() {
  const { session, usage, refreshUsage } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const accountName = session?.user.name || session?.user.email || "当前用户";

  async function refresh() {
    setRefreshing(true);
    setError("");
    try {
      await refreshUsage();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "刷新用量失败。");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="mx-auto grid w-full max-w-[1100px] gap-4 py-2" data-testid="user-usage-page">
      <Panel className="p-6">
        <div className="inline-card-header">
          <div className="min-w-0">
            <h1 className="text-[26px] font-extrabold text-[#061b3a]">用户用量</h1>
            <p className="mt-1 text-sm text-[#526c92]">
              {accountName} · {formatPeriod(usage.period)}
            </p>
          </div>
          <SecondaryButton onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? "刷新中..." : "刷新"}
          </SecondaryButton>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <UsageMetric label="本月总流量" value={formatBytes(usage.totalBytes)} />
          <UsageMetric label="本月总额度" value={formatQuota(usage.totalQuotaBytes)} />
        </div>

        {error && <div className="mt-4"><StatusMessage message={error} tone="error" /></div>}
      </Panel>

      <div className="grid gap-4 md:grid-cols-3">
        {serviceRows.map((row) => {
          const summary = usage.services[row.service];
          const quotaPercent = percentOfQuota(summary.bytes, summary.quotaBytes);
          return (
            <Panel className="p-5" key={row.service} testId={`usage-card-${row.service}`}>
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-xl font-extrabold text-[#061b3a]">{row.label}</h2>
                  <p className="mt-1 text-sm text-[#526c92]">{row.description}</p>
                </div>
                <span className="rounded-full bg-[#edf6ff] px-3 py-1 text-xs font-extrabold text-[#1476ff]">
                  本月
                </span>
              </div>

              <div className="mt-5">
                <div className="text-[30px] font-extrabold leading-tight text-[#061b3a]">
                  {formatBytes(summary.bytes)}
                </div>
                <div className="mt-1 text-sm text-[#526c92]">
                  额度 {formatQuota(summary.quotaBytes)}
                </div>
              </div>

              <div className="mt-5">
                <div className="h-2 overflow-hidden rounded-full bg-[#dceafa]">
                  <div
                    className="h-full rounded-full bg-[#1677ff]"
                    style={{ width: quotaPercent === null ? "0%" : formatPercent(quotaPercent) }}
                  />
                </div>
                <div className="mt-2 text-xs font-bold text-[#526c92]">
                  {quotaPercent === null ? "额度未配置" : `已用 ${formatPercent(quotaPercent)}`}
                </div>
              </div>
            </Panel>
          );
        })}
      </div>
    </div>
  );
}

function UsageMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-l-4 border-[#1677ff] pl-4">
      <div className="text-sm font-bold text-[#526c92]">{label}</div>
      <div className="mt-1 text-2xl font-extrabold text-[#061b3a]">{value}</div>
    </div>
  );
}

function formatQuota(quotaBytes: number | null) {
  return quotaBytes === null ? "未配置" : formatBytes(quotaBytes);
}

function percentOfQuota(bytes: number, quotaBytes: number | null) {
  if (quotaBytes === null || quotaBytes <= 0) return null;
  return Math.min(100, (bytes / quotaBytes) * 100);
}

function formatPeriod(period: UsagePeriod | null) {
  if (!period) return "正在读取本月统计";
  return `${formatDateTime(period.start)} 至 ${formatDateTime(period.end)}（${period.timezone}）`;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
