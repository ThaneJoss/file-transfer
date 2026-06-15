import { Cloud } from "lucide-react";
import type { ReactNode } from "react";

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
  activeRoute,
  children,
  onNavigate,
}: {
  activeRoute: AppRouteId;
  children: ReactNode;
  onNavigate: (route: AppRoute) => void;
}) {
  return (
    <main className="mx-auto flex h-dvh w-[min(1680px,calc(100vw_-_clamp(28px,4vw,72px)))] flex-col overflow-hidden py-[clamp(14px,1.8vw,24px)] max-[1180px]:h-auto max-[1180px]:min-h-dvh max-[1180px]:overflow-visible max-[1180px]:py-[clamp(18px,2.5vw,34px)]">
      <header className="mb-[clamp(12px,1.5vw,20px)] grid shrink-0 grid-cols-[minmax(210px,260px)_minmax(0,1fr)_minmax(160px,260px)] items-center gap-4 max-[1040px]:grid-cols-1 max-[1040px]:justify-items-center">
        <a
          className="inline-flex w-fit items-center gap-3 text-[22px] font-extrabold text-[#071b3a] max-[560px]:text-lg"
          href={routes[0].path}
          aria-label="文件中转站首页"
          onClick={(event) => {
            event.preventDefault();
            onNavigate(routes[0]);
          }}
        >
          <span className="grid size-11 place-items-center rounded-2xl bg-[#1677ff] text-white shadow-[0_12px_28px_rgba(47,125,246,0.34)]">
            <Cloud aria-hidden="true" size={26} />
          </span>
          <strong>文件中转站</strong>
        </a>

        <nav
          className="mx-auto flex max-w-full items-center gap-2 overflow-x-auto rounded-2xl border border-white/70 bg-white/70 p-1.5 text-[16px] font-extrabold text-[#344a68] shadow-[0_14px_38px_rgba(23,54,97,0.08)] backdrop-blur max-[700px]:w-full max-[700px]:justify-between max-[560px]:text-sm"
          aria-label="功能导航"
        >
          {routes.map((route) => (
            <a
              className={
                activeRoute === route.id
                  ? "inline-flex min-w-[118px] items-center justify-center rounded-xl bg-[#1677ff] px-7 py-3 text-white shadow-[0_10px_26px_rgba(47,125,246,0.22)] max-[700px]:min-w-0 max-[700px]:px-4 max-[700px]:py-2.5"
                  : "inline-flex items-center justify-center rounded-xl px-6 py-3 transition hover:bg-white hover:text-[#1476ff] max-[700px]:px-3 max-[700px]:py-2.5"
              }
              href={route.path}
              key={route.id}
              onClick={(event) => {
                event.preventDefault();
                onNavigate(route);
              }}
            >
              {route.label}
            </a>
          ))}
        </nav>
      </header>

      {children}
    </main>
  );
}
