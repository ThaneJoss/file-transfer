import { useCallback, useEffect, useMemo, useState } from "react";

import { AppShell, routes } from "./components/AppShell";
import type { AppRoute, AppRouteId } from "./components/AppShell";
import { ComingSoonPage } from "./pages/ComingSoonPage";
import DirectPage from "./pages/DirectPage";
import StunPage from "./pages/StunPage";

function routeFromPath(pathname: string): AppRoute {
  if (pathname === "/") return routes[0];
  return routes.find((route) => route.path === pathname) ?? routes[0];
}

export default function App() {
  const [activeRoute, setActiveRoute] = useState<AppRouteId>(() => routeFromPath(window.location.pathname).id);

  useEffect(() => {
    const onPopState = () => setActiveRoute(routeFromPath(window.location.pathname).id);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const handleNavigate = useCallback((route: AppRoute) => {
    if (window.location.pathname !== route.path) {
      window.history.pushState({}, "", route.path);
    }
    setActiveRoute(route.id);
  }, []);

  const page = useMemo(() => {
    switch (activeRoute) {
      case "stun":
        return <StunPage />;
      case "turn":
        return <ComingSoonPage title="TURN" />;
      case "sfu":
        return <ComingSoonPage title="SFU" />;
      case "r2":
        return <ComingSoonPage title="R2" />;
      case "direct":
      default:
        return <DirectPage />;
    }
  }, [activeRoute]);

  return (
    <AppShell activeRoute={activeRoute} onNavigate={handleNavigate}>
      {page}
    </AppShell>
  );
}
