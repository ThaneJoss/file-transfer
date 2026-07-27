import { ArrowLeft, Fingerprint, KeyRound, ShieldCheck, Sparkles } from "lucide-react";
import { Link } from "react-router";

import { ProductBrand } from "../component/ProductBrand";
import { AuthPage } from "../features/auth/AuthPage";

export default function LoginPage() {
  return (
    <main className="login-page" data-testid="login-page">
      <div className="login-page__grid" aria-hidden="true" />
      <header className="login-header">
        <ProductBrand ariaLabel="返回文件中转站" />
        <Link className="back-link" to="/">
          <ArrowLeft aria-hidden="true" size={16} />
          返回首页
        </Link>
      </header>

      <section className="login-layout">
        <aside className="auth-story">
          <div className="eyebrow">
            <span className="eyebrow__signal" aria-hidden="true" />
            Passwordless identity
          </div>
          <h1 className="mt-5 max-w-lg text-[clamp(36px,5vw,64px)] font-black leading-[0.98] tracking-[-0.06em] text-ink">
            身份验证，
            <span className="text-gradient block">无需记住密码</span>
          </h1>
          <p className="mt-5 max-w-md text-sm leading-7 text-muted">
            Passkey 使用设备生物识别或安全密钥验证身份。凭证不会离开你的设备，登录更快，也更不容易被钓鱼。
          </p>

          <div className="auth-story__features">
            <StoryFeature icon={Fingerprint} label="设备原生验证" />
            <StoryFeature icon={ShieldCheck} label="抗钓鱼凭证" />
            <StoryFeature icon={Sparkles} label="一触即达" />
          </div>

          <div className="auth-orb" aria-hidden="true">
            <span className="auth-orb__ring auth-orb__ring--one" />
            <span className="auth-orb__ring auth-orb__ring--two" />
            <span className="auth-orb__core">
              <KeyRound size={30} />
            </span>
            <i className="auth-orb__node auth-orb__node--one" />
            <i className="auth-orb__node auth-orb__node--two" />
            <i className="auth-orb__node auth-orb__node--three" />
          </div>
        </aside>

        <AuthPage />
      </section>
    </main>
  );
}

function StoryFeature({
  icon: Icon,
  label,
}: {
  icon: typeof Fingerprint;
  label: string;
}) {
  return (
    <span>
      <Icon aria-hidden="true" size={15} />
      {label}
    </span>
  );
}
