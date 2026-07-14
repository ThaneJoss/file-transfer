import { Cloud, LogIn, LogOut } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { Link, Outlet } from "react-router-dom";

import { formatBytes } from "../lib/files/format";
import { useAuth } from "../lib/auth/AuthProvider";
import type { UsageSnapshot } from "../lib/auth/AuthProvider";

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
          <span className="grid size-11 place-items-center rounded-lg bg-[#1677ff] text-white">
            <Cloud aria-hidden="true" size={26} />
          </span>
          <strong>文件中转站</strong>
        </Link>

        <div className="flex min-w-0 justify-end justify-self-end max-[760px]:justify-self-center" data-testid="account-area">
          {session ? (
            <div className="flex max-w-full min-w-0 items-center gap-2 rounded-lg border border-[#d7e5f6] bg-white px-3 py-2 text-sm">
              <Link
                className="grid min-w-0 flex-1 grid-cols-[minmax(86px,auto)_minmax(110px,150px)] items-center gap-3 rounded-xl px-2 py-1 hover:bg-[#eaf2ff] max-[520px]:grid-cols-1 max-[520px]:gap-1.5"
                to="/account"
                aria-label="用户页面"
              >
                <div className="min-w-0 text-right max-[520px]:text-center">
                  <div className="truncate font-bold text-[#071b3a]">{session.user.name || session.user.email}</div>
                  <div className="text-[11px] font-semibold text-[#6b7f9f]">本月用量</div>
                </div>
                <HeaderUsageSummary usage={usage} />
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
            <Link className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-3 text-sm font-bold text-[#1476ff]" to="/login">
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

function HeaderUsageSummary({ usage }: { usage: UsageSnapshot }) {
  const quota = usage.totalQuotaBytes;
  const percent = quota && quota > 0 ? Math.min(100, (usage.totalBytes / quota) * 100) : 0;
  const label = quota === null
    ? `${formatBytes(usage.totalBytes)} 已用`
    : `${formatBytes(usage.totalBytes)} / ${formatBytes(quota)}`;

  return (
    <div className="grid min-w-0 gap-1.5" aria-label="本月文件用量" data-testid="header-usage-summary" title={label}>
      <span className="truncate text-right text-xs font-extrabold text-[#365a88] max-[520px]:text-center">{label}</span>
      <span className="h-2 overflow-hidden rounded-full bg-[#dce8f7]">
        <span className="block h-full rounded-full bg-[#1677ff]" style={{ width: `${percent}%` }} />
      </span>
    </div>
  );
}
