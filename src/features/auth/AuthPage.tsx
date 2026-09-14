import { Fingerprint, ShieldCheck, UserPlus } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";

import { Panel } from "../../component/Panel";
import { PrimaryButton, StatusMessage, TextInput } from "../../component/TransferControls";
import { authClient } from "../../lib/auth/client";
import { useAuth } from "../../lib/auth/AuthProvider";
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
    <div className="auth-page">
      <Panel className="auth-panel">
        <div className="auth-panel__icon">
          {mode === "sign-in"
            ? <Fingerprint aria-hidden="true" size={25} />
            : <UserPlus aria-hidden="true" size={25} />}
        </div>
        <span className="panel-kicker">{mode === "sign-in" ? "Welcome back" : "Create identity"}</span>
        <h1 className="mt-2 text-[28px] font-semibold text-ink">
          {mode === "sign-in" ? "Passkey 登录" : "Passkey 注册"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted">
          {mode === "sign-in"
            ? "使用此设备上的 Passkey 验证身份。"
            : "创建仅属于你的无密码身份凭证。"}
        </p>

        <div className="auth-mode-switch" aria-label="选择登录或注册">
          <button
            type="button"
            data-active={mode === "sign-in" || undefined}
            aria-pressed={mode === "sign-in"}
            onClick={() => {
              setMode("sign-in");
              setError("");
            }}
          >
            登录
          </button>
          <button
            type="button"
            data-active={mode === "sign-up" || undefined}
            aria-pressed={mode === "sign-up"}
            onClick={() => {
              setMode("sign-up");
              setError("");
            }}
          >
            注册
          </button>
        </div>

        <form className="mt-5 grid gap-4" onSubmit={(event) => void submit(event)}>
          {mode === "sign-up" && (
            <TextInput
              autoComplete="name"
              label="Name"
              value={name}
              onChange={setName}
              placeholder="你的名字"
            />
          )}
          {mode === "sign-in" && (
            <StatusMessage message="点击继续后，浏览器会打开 Passkey 选择器。" tone="info" />
          )}
          {!passkeySupported && (
            <StatusMessage message="当前浏览器不支持 Passkey，请使用支持 WebAuthn 的浏览器。" tone="error" />
          )}
          <PrimaryButton
            className="w-full"
            type="submit"
            disabled={submitting || !passkeySupported || (mode === "sign-up" && !name.trim())}
          >
            <Fingerprint aria-hidden="true" size={17} />
            {submitting ? "处理中..." : mode === "sign-in" ? "使用 Passkey 登录" : "创建 Passkey 并登录"}
          </PrimaryButton>
        </form>

        {(error || sessionError) && (
          <div className="mt-4">
            <StatusMessage message={error || sessionError} tone="error" />
          </div>
        )}

        <div className="auth-panel__footer">
          <ShieldCheck aria-hidden="true" size={14} />
          <span>{mode === "sign-in" ? "还没有账号？" : "已经有账号？"}</span>
          <button
            type="button"
            onClick={() => {
              setMode(mode === "sign-in" ? "sign-up" : "sign-in");
              setError("");
            }}
          >
            {mode === "sign-in" ? "切换到注册" : "切换到登录"}
          </button>
        </div>
      </Panel>
      <p className="auth-page__legal">
        继续即表示你授权浏览器使用 WebAuthn 完成身份验证
      </p>
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
