import { useState } from "react";
import type { FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";

import { PrimaryButton, SecondaryButton, StatusMessage, TextInput } from "../../component/TransferControls";
import { authClient } from "../../lib/auth/client";
import { useAuth } from "../../lib/auth/AuthProvider";
import { Panel } from "../../component/Panel";

type AuthMode = "sign-in" | "sign-up";

export function AuthPage() {
  const { session, isPending, sessionError, refreshSession } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const from = (location.state as { from?: string } | null)?.from ?? "/turn";

  if (!isPending && session) return <Navigate to={from} replace />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const result = mode === "sign-up"
        ? await authClient.signUp.email({ name: name.trim(), email: email.trim(), password })
        : await authClient.signIn.email({ email: email.trim(), password });
      if (result.error) throw new Error(result.error.message || "鉴权请求失败。");
      await refreshSession();
      navigate(from, { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "鉴权请求失败。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto grid w-full max-w-[560px] flex-1 place-items-center py-8">
      <Panel className="w-full p-7">
        <h1 className="text-[26px] font-extrabold text-[#061b3a]">{mode === "sign-in" ? "登录" : "注册"}</h1>
        <p className="mt-2 text-[15px] text-[#526c92]">登录后可使用 TURN、R2 和 SFU，Direct 与 STUN 无需登录。</p>
        <form className="mt-6 grid gap-4" onSubmit={(event) => void submit(event)}>
          {mode === "sign-up" && (
            <TextInput label="Name" value={name} onChange={setName} placeholder="你的名字" />
          )}
          <TextInput label="Email" value={email} onChange={setEmail} placeholder="name@example.com" type="email" />
          <TextInput label="Password" value={password} onChange={setPassword} placeholder="至少 8 位" type="password" />
          <PrimaryButton
            type="submit"
            disabled={submitting || !email.trim() || !password || (mode === "sign-up" && !name.trim())}
          >
            {submitting ? "处理中..." : mode === "sign-in" ? "登录" : "注册并登录"}
          </PrimaryButton>
        </form>
        {(error || sessionError) && <div className="mt-4"><StatusMessage message={error || sessionError} tone="error" /></div>}
        <div className="mt-5 flex items-center justify-between gap-3 text-sm text-[#526c92]">
          <span>{mode === "sign-in" ? "还没有账号？" : "已经有账号？"}</span>
          <SecondaryButton onClick={() => { setMode(mode === "sign-in" ? "sign-up" : "sign-in"); setError(""); }}>
            {mode === "sign-in" ? "切换到注册" : "切换到登录"}
          </SecondaryButton>
        </div>
      </Panel>
    </div>
  );
}
