import { Cloud } from "lucide-react";
import type { ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";

export type AppRouteId = "direct" | "stun" | "turn" | "sfu" | "r2";

export type AppRoute = {
  id: AppRouteId;
  label: string;
  path: string;
};

export const routes: AppRoute[] = [
  { id: "direct", label: "Direct", path: "/direct" },
  { id: "stun", label: "STUN", path: "/stun" },
  { id: "turn", label: "TURN", path: "/turn" },
  { id: "sfu", label: "SFU", path: "/sfu" },
  { id: "r2", label: "R2", path: "/r2" },
];

export function AppShell({
  children,
}: {
  children: ReactNode;
}) {
  const location = useLocation();
  const activeRoute = routes.find((route) => route.path === location.pathname)?.id ?? "direct";
  const activeRouteIndex = Math.max(
    0,
    routes.findIndex((route) => route.id === activeRoute),
  );

  return (
    <main
      className="app-shell mx-auto flex h-dvh min-w-0 flex-col overflow-hidden"
      data-testid="app-shell"
    >
      <header
        className="mb-[clamp(12px,1.5vw,20px)] grid min-w-0 shrink-0 grid-cols-[minmax(210px,260px)_minmax(0,1fr)_minmax(160px,260px)] items-center gap-4 max-[1040px]:grid-cols-1 max-[1040px]:justify-items-center"
        data-testid="app-header"
      >
        <Link
          className="inline-flex w-fit items-center gap-3 text-[22px] font-extrabold text-[#071b3a] max-[560px]:text-lg"
          to={routes[0].path}
          aria-label="文件中转站首页"
          data-testid="app-brand"
        >
          <span className="grid size-11 place-items-center rounded-2xl bg-[#1677ff] text-white shadow-[0_12px_28px_rgba(47,125,246,0.34)]">
            <Cloud aria-hidden="true" size={26} />
          </span>
          <strong>文件中转站</strong>
        </Link>

        <nav
          className="mx-auto min-w-0 max-w-full overflow-x-auto rounded-2xl border border-white/70 bg-white/70 p-1.5 text-[16px] font-extrabold text-[#344a68] shadow-[0_14px_38px_rgba(23,54,97,0.08)] backdrop-blur max-[700px]:w-full max-[560px]:text-sm"
          aria-label="功能导航"
          data-testid="app-nav"
        >
          <div className="relative grid min-w-[520px] grid-cols-5 max-[700px]:min-w-0">
            <span
              aria-hidden="true"
              className="absolute inset-y-0 left-0 z-0 w-1/5 rounded-xl bg-[#1677ff] shadow-[0_10px_26px_rgba(47,125,246,0.22)]"
              data-testid="nav-active-indicator"
              style={{ transform: `translateX(${activeRouteIndex * 100}%)` }}
            />
            {routes.map((route) => {
              const active = activeRoute === route.id;
              return (
                <NavLink
                  className={`relative z-10 flex min-h-12 w-full items-center justify-center whitespace-nowrap rounded-xl px-4 text-center transition-colors duration-200 max-[700px]:px-3 max-[700px]:py-2.5 ${
                    active ? "text-white" : "text-[#344a68] hover:text-[#1476ff]"
                  }`}
                  key={route.id}
                  to={route.path}
                  data-route-id={route.id}
                  data-testid={`nav-item-${route.id}`}
                >
                  {route.label}
                </NavLink>
              );
            })}
          </div>
        </nav>
      </header>

      <section className="app-page-slot flex min-h-0 min-w-0 flex-1 flex-col overflow-x-clip overflow-y-auto" data-testid="page-slot">
        {children}
      </section>
    </main>
  );
}
