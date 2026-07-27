import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  CalendarDays,
  DatabaseZap,
  Gauge,
  HardDrive,
  Pencil,
  RefreshCw,
  TicketCheck,
  UserRound,
} from "lucide-react";

import { Panel } from "../../component/Panel";
import { PrimaryButton, SecondaryButton, StatusMessage, TextInput } from "../../component/TransferControls";
import { authClient } from "../../lib/auth/client";
import { useAuth } from "../../lib/auth/AuthProvider";
import type { UsagePeriod } from "../../lib/auth/AuthProvider";
import type { UsageUnit } from "../../lib/auth/AuthProvider";
import { formatBytes, formatPercent } from "../../lib/files/format";

const serviceRows: Array<{
  id: "files" | "durable";
  label: string;
  description: string;
}> = [
  { id: "files", label: "文件流量", description: "所有传输线路校验成功的文件流量" },
  { id: "durable", label: "取件码请求", description: "生成、读取和协调取件码的次数" },
];

export function UserUsagePage() {
  const { session, usage, refreshSession, refreshUsage } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const accountName = session?.user.name || session?.user.email || "当前用户";

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError("");
    setNotice("");
    try {
      await refreshUsage();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "刷新用量失败。");
    } finally {
      setRefreshing(false);
    }
  }, [refreshUsage]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName) {
      setError("用户名不能为空。");
      return;
    }

    setSavingName(true);
    setError("");
    setNotice("");
    try {
      const result = await authClient.updateUser({ name: nextName });
      if (result.error) throw new Error(result.error.message || "修改用户名失败。");
      await refreshSession();
      setEditingName(false);
      setNotice("用户名已更新。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "修改用户名失败。");
    } finally {
      setSavingName(false);
    }
  }

  function startEditingName() {
    setName(session?.user.name || "");
    setError("");
    setNotice("");
    setEditingName(true);
  }

  return (
    <div className="account-page" data-testid="user-usage-page">
      <Panel className="account-hero">
        <div className="account-hero__header">
          <div className="flex min-w-0 items-center gap-4">
            <span className="account-hero__avatar">
              <UserRound aria-hidden="true" size={25} />
            </span>
            <div className="min-w-0">
              <span className="panel-kicker">Usage control center</span>
              <h1 className="mt-1.5 text-[28px] font-black tracking-[-0.04em] text-ink">账户与用量</h1>
              <p className="mt-1 truncate text-sm font-bold text-soft">{accountName}</p>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2 max-sm:justify-start">
            <SecondaryButton onClick={startEditingName} disabled={editingName || savingName}>
              <Pencil aria-hidden="true" size={15} />
              修改用户名
            </SecondaryButton>
            <SecondaryButton onClick={() => void refresh()} disabled={refreshing || savingName}>
              <RefreshCw className={refreshing ? "animate-spin" : ""} aria-hidden="true" size={15} />
              {refreshing ? "刷新中..." : "刷新"}
            </SecondaryButton>
          </div>
        </div>

        {editingName && (
          <form className="account-name-form" onSubmit={(event) => void saveName(event)}>
            <TextInput autoComplete="name" label="新用户名" value={name} onChange={setName} placeholder="输入新的用户名" />
            <div className="flex flex-wrap justify-end gap-2">
              <SecondaryButton
                onClick={() => {
                  setEditingName(false);
                  setError("");
                }}
                disabled={savingName}
              >
                取消
              </SecondaryButton>
              <PrimaryButton
                type="submit"
                disabled={savingName || !name.trim() || name.trim() === session?.user.name}
              >
                {savingName ? "保存中..." : "保存"}
              </PrimaryButton>
            </div>
          </form>
        )}

        <div className="account-period">
          <CalendarDays aria-hidden="true" size={14} />
          <span>{formatPeriod(usage.period)}</span>
        </div>

        <div className="usage-metric-grid">
          <UsageMetric icon={HardDrive} label="本月总流量" value={formatBytes(usage.totalBytes)} />
          <UsageMetric icon={Gauge} label="本月总额度" value={formatQuota(usage.totalQuotaBytes)} />
          <UsageMetric icon={TicketCheck} label="取件码请求" value={formatQuantity(usage.totals.requests, "requests")} />
          <UsageMetric icon={DatabaseZap} label="请求额度" value={formatQuotaByUnit(usage.quotas.requests, "requests")} />
        </div>

        {error && <div className="mt-4"><StatusMessage message={error} tone="error" /></div>}
        {notice && <div className="mt-4"><StatusMessage message={notice} tone="info" /></div>}
      </Panel>

      <div className="usage-service-grid">
        {serviceRows.map((row) => {
          const summary = row.id === "files"
            ? { usage: usage.totalBytes, quota: usage.totalQuotaBytes, unit: "bytes" as const }
            : usage.services.durable;
          const quotaPercent = percentOfQuota(summary.usage, summary.quota);
          return (
            <Panel className="usage-service-card" key={row.id} testId={`usage-card-${row.id}`}>
              <div className="flex min-w-0 items-start justify-between gap-4">
                <div className="min-w-0">
                  <span className="panel-kicker">{row.id === "files" ? "Bandwidth" : "Coordination"}</span>
                  <h2 className="mt-2 text-xl font-black tracking-[-0.03em] text-ink">{row.label}</h2>
                  <p className="mt-1 max-w-sm text-xs leading-5 text-muted">{row.description}</p>
                </div>
                <span className="usage-service-card__icon">
                  {row.id === "files"
                    ? <HardDrive aria-hidden="true" size={20} />
                    : <DatabaseZap aria-hidden="true" size={20} />}
                </span>
              </div>

              <div className="mt-6">
                <div className="text-[clamp(28px,4vw,38px)] font-black leading-tight tracking-[-0.045em] text-ink">
                  {formatQuantity(summary.usage, summary.unit)}
                </div>
                <div className="mt-1 font-mono text-[10px] font-bold tracking-[0.08em] text-muted uppercase">
                  Quota · {formatQuotaByUnit(summary.quota, summary.unit)}
                </div>
              </div>

              <div className="mt-5">
                <div
                  className="progress-track"
                  role="progressbar"
                  aria-label={`${row.label}额度使用率`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={quotaPercent === null ? 0 : Math.round(quotaPercent)}
                >
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: quotaPercent === null ? "0%" : formatPercent(quotaPercent) }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between text-[10px] font-bold text-muted">
                  <span>本月</span>
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

function UsageMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof HardDrive;
  label: string;
  value: string;
}) {
  return (
    <div className="usage-metric">
      <span className="usage-metric__icon">
        <Icon aria-hidden="true" size={16} />
      </span>
      <div className="min-w-0">
        <div className="truncate text-[10px] font-black tracking-[0.08em] text-muted uppercase">{label}</div>
        <div className="mt-1 truncate text-xl font-black tracking-[-0.035em] text-ink" title={value}>{value}</div>
      </div>
    </div>
  );
}

function formatQuota(quotaBytes: number | null) {
  return quotaBytes === null ? "未配置" : formatBytes(quotaBytes);
}

function formatQuantity(value: number, unit: UsageUnit) {
  return unit === "bytes" ? formatBytes(value) : `${value.toLocaleString("zh-CN")} 次`;
}

function formatQuotaByUnit(quota: number | null, unit: UsageUnit) {
  return quota === null ? "未配置" : formatQuantity(quota, unit);
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
