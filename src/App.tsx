import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";

import { ProtectedRoute } from "./features/auth/ProtectedRoute";
import { AppShell } from "./layout/AppShell";

const HomePage = lazy(() => import("./pages/HomePage"));
const LoginPage = lazy(() => import("./pages/LoginPage"));
const UserPage = lazy(() => import("./pages/UserPage"));

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<AppShell />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/account" element={<ProtectedRoute><UserPage /></ProtectedRoute>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

function PageFallback() {
  return (
    <div className="page-fallback" role="status">
      <span className="page-fallback__pulse" aria-hidden="true" />
      <p className="text-sm font-normal text-muted">正在加载页面...</p>
    </div>
  );
}
