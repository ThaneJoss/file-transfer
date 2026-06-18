import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "./layout/AppShell";
import DirectPage from "./pages/DirectPage";
import R2Page from "./pages/R2Page";
import SfuPage from "./pages/SfuPage";
import STUNPage from "./pages/STUNPage";
import TURNPage from "./pages/TURNPage";

export default function App() {
  return (
    <BrowserRouter>
      <AppShell>
        <Routes>
          <Route path="/" element={<Navigate to="/direct" replace />} />
          <Route path="/direct" element={<DirectPage />} />
          <Route path="/stun" element={<STUNPage />} />
          <Route path="/turn" element={<TURNPage />} />
          <Route path="/sfu" element={<SfuPage />} />
          <Route path="/r2" element={<R2Page />} />
          <Route path="*" element={<Navigate to="/direct" replace />} />
        </Routes>
      </AppShell>
    </BrowserRouter>
  );
}
