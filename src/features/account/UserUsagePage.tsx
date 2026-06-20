import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";

import { Panel } from "../../component/Panel";
import { PrimaryButton, SecondaryButton, StatusMessage, TextInput } from "../../component/TransferControls";
import { authClient } from "../../lib/auth/client";
import { useAuth } from "../../lib/auth/AuthProvider";
import type { UsagePeriod, UsageService } from "../../lib/auth/AuthProvider";
import type { UsageUnit } from "../../lib/auth/AuthProvider";
import { formatBytes, formatPercent } from "../../lib/files/format";

const serviceRows: Array<{
  service: UsageService;
  label: string;
  description: string;
}> = [
  { service: "direct", label: "Direct", description: "局域网/直连传输流量" },
  { service: "stun", label: "STUN", description: "公网点对点传输流量" },
  { service: "turn", label: "TURN", description: "中继传输流量" },
  { service: "sfu", label: "SFU", description: "服务器转发流量" },
  { service: "r2", label: "R2", description: "对象存储上传/下载流量" },
  { service: "durable", label: "Durable", description: "取件码信令请求次数" },
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
    <div className="mx-auto grid w-full max-w-[1100px] gap-4 py-2" data-testid="user-usage-page">
      <Panel className="p-6">
        <div className="inline-card-header">
          <div className="min-w-0">
            <h1 className="text-[26px] font-extrabold text-[#061b3a]">用户用量</h1>
            <p className="mt-1 text-sm text-[#526c92]">
              {accountName} · {formatPeriod(usage.period)}
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <SecondaryButton onClick={startEditingName} disabled={editingName || savingName}>
              修改用户名
            </SecondaryButton>
            <SecondaryButton onClick={() => void refresh()} disabled={refreshing || savingName}>
              {refreshing ? "刷新中..." : "刷新"}
            </SecondaryButton>
          </div>
        </div>

        {editingName && (
          <form className="mt-5 grid gap-3 border-t border-[#dceafa] pt-5" onSubmit={(event) => void saveName(event)}>
            <TextInput label="新用户名" value={name} onChange={setName} placeholder="输入新的用户名" />
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

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <UsageMetric label="本月总流量" value={formatBytes(usage.totalBytes)} />
          <UsageMetric label="本月总额度" value={formatQuota(usage.totalQuotaBytes)} />
          <UsageMetric label="Durable 请求" value={formatQuantity(usage.totals.requests, "requests")} />
          <UsageMetric label="Durable 额度" value={formatQuotaByUnit(usage.quotas.requests, "requests")} />
        </div>

        {error && <div className="mt-4"><StatusMessage message={error} tone="error" /></div>}
        {notice && <div className="mt-4"><StatusMessage message={notice} tone="info" /></div>}
      </Panel>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {serviceRows.map((row) => {
          const summary = usage.services[row.service];
          const quotaPercent = percentOfQuota(summary.usage, summary.quota);
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
                  {formatQuantity(summary.usage, summary.unit)}
                </div>
                <div className="mt-1 text-sm text-[#526c92]">
                  额度 {formatQuotaByUnit(summary.quota, summary.unit)}
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
