import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { useAuth } from "../../lib/auth/AuthProvider";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, isPending } = useAuth();
  const location = useLocation();

  if (isPending && !session) {
    return <div className="grid min-h-64 place-items-center text-[#526c92]">正在检查登录状态...</div>;
  }
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}
