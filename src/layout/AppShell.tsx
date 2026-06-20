import { Cloud, LogIn, LogOut } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { Link, Outlet } from "react-router-dom";

import { formatBytes, formatPercent } from "../lib/files/format";
import { useAuth } from "../lib/auth/AuthProvider";
import type { UsageSnapshot, UsageService } from "../lib/auth/AuthProvider";

const headerUsageRows: Array<{ service: Exclude<UsageService, "durable">; label: string; color: string }> = [
  { service: "direct", label: "Direct", color: "#1677ff" },
  { service: "stun", label: "STUN", color: "#23a26d" },
  { service: "turn", label: "TURN", color: "#ef8f25" },
  { service: "sfu", label: "SFU", color: "#7c5cff" },
  { service: "r2", label: "R2", color: "#0e9fb3" },
];

const usageRingRadius = 17;
const usageRingCircumference = 2 * Math.PI * usageRingRadius;

export function AppShell({
  children,
}: {
  children?: ReactNode;
}) {
  const { session, usage, signOut } = useAuth();
  const [accountError, setAccountError] = useState("");

  return (
    <main
      className="app-shell mx-auto flex h-dvh min-w-0 flex-col overflow-hidden"
      data-testid="app-shell"
    >
      <header
        className="mb-[clamp(12px,1.5vw,20px)] grid min-w-0 shrink-0 grid-cols-[minmax(210px,1fr)_minmax(0,auto)] items-start gap-4 max-[760px]:grid-cols-1 max-[760px]:justify-items-center"
        data-testid="app-header"
      >
        <Link
          className="inline-flex w-fit items-center gap-3 text-[22px] font-extrabold text-[#071b3a] max-[560px]:text-lg"
          to="/"
          aria-label="文件中转站首页"
          data-testid="app-brand"
        >
          <span className="grid size-11 place-items-center rounded-2xl bg-[#1677ff] text-white shadow-[0_12px_28px_rgba(47,125,246,0.34)]">
            <Cloud aria-hidden="true" size={26} />
          </span>
          <strong>文件中转站</strong>
        </Link>

        <div className="flex min-w-0 justify-end justify-self-end max-[760px]:justify-self-center" data-testid="account-area">
          {session ? (
            <div className="flex max-w-full min-w-0 items-center gap-2 rounded-2xl border border-white/70 bg-white/75 px-3 py-2 text-sm shadow-[0_14px_38px_rgba(23,54,97,0.08)] backdrop-blur">
              <Link
                className="grid min-w-0 flex-1 grid-cols-[minmax(86px,auto)_auto] items-center gap-3 rounded-xl px-2 py-1 hover:bg-[#eaf2ff] max-[520px]:grid-cols-1 max-[520px]:gap-1.5"
                to="/account"
                aria-label="用户页面"
              >
                <div className="min-w-0 text-right max-[520px]:text-center">
                  <div className="truncate font-bold text-[#071b3a]">{session.user.name || session.user.email}</div>
                  <div className="text-[11px] font-semibold text-[#6b7f9f]">本月用量</div>
                </div>
                <HeaderUsageBars usage={usage} />
              </Link>
              <button
                className="mt-0.5 rounded-lg p-2 text-[#526c92] hover:bg-[#eaf2ff] hover:text-[#1476ff]"
                onClick={() => void signOut().catch((error) => setAccountError(error instanceof Error ? error.message : "退出登录失败。"))}
                aria-label="退出登录"
                title={accountError || "退出登录"}
              >
                <LogOut aria-hidden="true" size={18} />
              </button>
              {accountError && <span className="sr-only" role="alert">{accountError}</span>}
            </div>
          ) : (
            <Link className="inline-flex items-center gap-2 rounded-xl bg-white/70 px-4 py-3 text-sm font-bold text-[#1476ff]" to="/login">
              <LogIn aria-hidden="true" size={18} />
              登录
            </Link>
          )}
        </div>
      </header>

      <section className="app-page-slot flex min-h-0 min-w-0 flex-1 flex-col overflow-x-clip overflow-y-auto" data-testid="page-slot">
        {children ?? <Outlet />}
      </section>
    </main>
  );
}

function HeaderUsageBars({ usage }: { usage: UsageSnapshot }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-2" aria-label="本月传输额度" data-testid="header-usage-bars">
      {headerUsageRows.map((row) => {
        const summary = usage.services[row.service];
        const percent = summary.quota && summary.quota > 0 ? Math.min(100, (summary.usage / summary.quota) * 100) : null;
        const normalizedPercent = percent === null ? 0 : Math.max(0, Math.min(100, percent));
        const dash = (normalizedPercent / 100) * usageRingCircumference;
        const displayValue = percent === null ? "--" : formatPercent(percent);
        const title = `${row.label}: ${formatBytes(summary.usage)} / ${summary.quota === null ? "未配置" : formatBytes(summary.quota)}`;

        return (
          <div className="grid w-[46px] shrink-0 justify-items-center gap-1 text-center text-[10px] leading-none" key={row.service} title={title}>
            <span className="relative grid size-11 place-items-center">
              <svg className="absolute inset-0 size-11 -rotate-90" viewBox="0 0 44 44" aria-hidden="true">
                <circle cx="22" cy="22" fill="none" r={usageRingRadius} stroke="#dceafa" strokeWidth="5" />
                <circle
                  cx="22"
                  cy="22"
                  fill="none"
                  r={usageRingRadius}
                  stroke={row.color}
                  strokeDasharray={`${dash} ${usageRingCircumference - dash}`}
                  strokeLinecap="round"
                  strokeWidth="5"
                />
              </svg>
              <span className="relative font-extrabold text-[#071b3a]">{displayValue}</span>
            </span>
            <span className="max-w-full truncate font-extrabold text-[#526c92]">{row.label}</span>
          </div>
        );
      })}
    </div>
  );
}
