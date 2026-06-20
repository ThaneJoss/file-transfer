import { Cloud, LogIn, LogOut } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { Link, Outlet } from "react-router-dom";

import { formatBytes, formatPercent } from "../lib/files/format";
import { useAuth } from "../lib/auth/AuthProvider";
import type { UsageSnapshot, UsageService } from "../lib/auth/AuthProvider";

const headerUsageRows: Array<{ service: Exclude<UsageService, "durable">; label: string }> = [
  { service: "direct", label: "Direct" },
  { service: "stun", label: "STUN" },
  { service: "turn", label: "TURN" },
  { service: "sfu", label: "SFU" },
  { service: "r2", label: "R2" },
];

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
        className="mb-[clamp(12px,1.5vw,20px)] grid min-w-0 shrink-0 grid-cols-[minmax(210px,1fr)_minmax(260px,340px)] items-start gap-4 max-[760px]:grid-cols-1 max-[760px]:justify-items-center"
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

        <div className="flex min-w-0 justify-end" data-testid="account-area">
          {session ? (
            <div className="flex w-full min-w-0 items-start gap-2 rounded-2xl border border-white/70 bg-white/70 px-3 py-2 text-sm shadow-[0_14px_38px_rgba(23,54,97,0.08)]">
              <Link className="min-w-0 flex-1 rounded-lg px-2 py-1 hover:bg-[#eaf2ff]" to="/account" aria-label="用户页面">
                <div className="truncate font-bold text-[#071b3a]">{session.user.name || session.user.email}</div>
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
    <div className="mt-1 grid gap-0.5" aria-label="本月传输额度" data-testid="header-usage-bars">
      {headerUsageRows.map((row) => {
        const summary = usage.services[row.service];
        const percent = summary.quota && summary.quota > 0 ? Math.min(100, (summary.usage / summary.quota) * 100) : null;
        return (
          <div className="grid min-w-0 grid-cols-[42px_minmax(0,1fr)_58px] items-center gap-1.5 text-[10px] leading-3" key={row.service}>
            <span className="truncate font-bold text-[#526c92]">{row.label}</span>
            <span className="h-1.5 overflow-hidden rounded-full bg-[#dceafa]">
              <span
                className="block h-full rounded-full bg-[#1677ff]"
                style={{ width: percent === null ? "0%" : formatPercent(percent) }}
              />
            </span>
            <span className="truncate text-right font-bold text-[#526c92]" title={`${formatBytes(summary.usage)} / ${summary.quota === null ? "未配置" : formatBytes(summary.quota)}`}>
              {percent === null ? formatBytes(summary.usage) : formatPercent(percent)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
