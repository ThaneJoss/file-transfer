import { Activity, LogIn, LogOut, UserRound } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { Link, Outlet } from "react-router";

import { ProductBrand } from "../component/ProductBrand";
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
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <header
        className="app-header grid min-w-0 shrink-0 grid-cols-[minmax(190px,1fr)_auto_minmax(190px,1fr)] items-center gap-4"
        data-testid="app-header"
      >
        <ProductBrand testId="app-brand" />

        <div className="network-status hidden items-center gap-2.5 lg:flex" aria-label="传输网络已就绪">
          <span className="network-status__pulse" />
          <Activity aria-hidden="true" size={14} />
          <span>多线路网络已就绪</span>
        </div>

        <div className="flex min-w-0 justify-end" data-testid="account-area">
          {session ? (
            <div className="account-cluster">
              <Link
                className="account-summary"
                to="/account"
                aria-label="用户页面"
              >
                <span className="account-avatar" aria-hidden="true">
                  <UserRound size={17} />
                </span>
                <span className="hidden min-w-0 sm:block">
                  <span className="block max-w-32 truncate text-xs font-black text-ink">
                    {session.user.name || session.user.email}
                  </span>
                  <HeaderUsageSummary usage={usage} />
                </span>
              </Link>
              <button
                className="account-action"
                onClick={() => void signOut().catch((error) => setAccountError(error instanceof Error ? error.message : "退出登录失败。"))}
                aria-label="退出登录"
                title={accountError || "退出登录"}
              >
                <LogOut aria-hidden="true" size={17} />
              </button>
              {accountError && <span className="sr-only" role="alert">{accountError}</span>}
            </div>
          ) : (
            <Link className="header-login" to="/login">
              <LogIn aria-hidden="true" size={17} />
              <span>登录</span>
            </Link>
          )}
        </div>
      </header>

      <section
        className="app-page-slot flex min-h-0 min-w-0 flex-1 flex-col overflow-x-clip overflow-y-auto"
        data-testid="page-slot"
        id="main-content"
      >
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
    <span
      className="mt-1 grid min-w-0 grid-cols-[1fr_42px] items-center gap-2"
      aria-label="本月文件用量"
      data-testid="header-usage-summary"
      title={label}
    >
      <span className="truncate font-mono text-[9px] font-bold text-muted">{label}</span>
      <span
        className="h-1 overflow-hidden rounded-full bg-white/10"
        role="progressbar"
        aria-label="本月文件用量比例"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <span className="block h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
      </span>
    </span>
  );
}
