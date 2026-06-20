import { useState } from "react";
import type { FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";

import { PrimaryButton, SecondaryButton, StatusMessage, TextInput } from "../../component/TransferControls";
import { authClient } from "../../lib/auth/client";
import { useAuth } from "../../lib/auth/AuthProvider";
import { Panel } from "../../component/Panel";
import { createPasskeyRegistrationContext } from "./services/passkeyRegistration";

type AuthMode = "sign-in" | "sign-up";

export function AuthPage() {
  const { session, isPending, sessionError, refreshSession } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const from = (location.state as { from?: string } | null)?.from ?? "/";
  const passkeySupported = supportsPasskeys();

  if (!isPending && session) return <Navigate to={from} replace />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!passkeySupported) {
      setError("当前浏览器不支持 Passkey。");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const result = mode === "sign-up"
        ? await registerPasskey(name.trim())
        : await authClient.signIn.passkey();
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
        <h1 className="text-[26px] font-extrabold text-[#061b3a]">
          {mode === "sign-in" ? "Passkey 登录" : "Passkey 注册"}
        </h1>
        <p className="mt-2 text-[15px] text-[#526c92]">
          只使用 Passkey 鉴权。登录后可使用 TURN、R2 和 SFU，Direct 与 STUN 无需登录。
        </p>
        <form className="mt-6 grid gap-4" onSubmit={(event) => void submit(event)}>
          {mode === "sign-up" && (
            <TextInput label="Name" value={name} onChange={setName} placeholder="你的名字" />
          )}
          {mode === "sign-in" && (
            <StatusMessage message="点击按钮后，浏览器会打开 Passkey 选择器。" tone="info" />
          )}
          {!passkeySupported && (
            <StatusMessage message="当前浏览器不支持 Passkey，请使用支持 WebAuthn 的浏览器。" tone="error" />
          )}
          <PrimaryButton
            type="submit"
            disabled={submitting || !passkeySupported || (mode === "sign-up" && !name.trim())}
          >
            {submitting ? "处理中..." : mode === "sign-in" ? "使用 Passkey 登录" : "创建 Passkey 并登录"}
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

async function registerPasskey(name: string) {
  const { context } = await createPasskeyRegistrationContext(name);
  return authClient.passkey.addPasskey({ name, context });
}

function supportsPasskeys() {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential === "function" &&
    typeof navigator !== "undefined" &&
    typeof navigator.credentials?.create === "function" &&
    typeof navigator.credentials?.get === "function"
  );
}
