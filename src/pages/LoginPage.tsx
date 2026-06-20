import { Cloud } from "lucide-react";
import { Link } from "react-router-dom";

import { AuthPage } from "../features/auth/AuthPage";

export default function LoginPage() {
  return (
    <main
      className="mx-auto flex min-h-dvh w-full max-w-[1180px] flex-col px-[clamp(18px,4vw,56px)] py-[clamp(18px,3vw,42px)]"
      data-testid="login-page"
    >
      <header className="flex shrink-0 items-center justify-between gap-4">
        <Link
          className="inline-flex items-center gap-3 text-[22px] font-extrabold text-[#071b3a] max-[560px]:text-lg"
          to="/"
          aria-label="返回文件中转站"
        >
          <span className="grid size-11 place-items-center rounded-2xl bg-[#1677ff] text-white shadow-[0_12px_28px_rgba(47,125,246,0.34)]">
            <Cloud aria-hidden="true" size={26} />
          </span>
          <strong>文件中转站</strong>
        </Link>
        <Link className="rounded-xl bg-white/70 px-4 py-3 text-sm font-bold text-[#1476ff]" to="/">
          返回首页
        </Link>
      </header>

      <section className="grid min-h-0 flex-1 place-items-center py-8">
        <AuthPage />
      </section>
    </main>
  );
}
