import { ArrowLeft, Fingerprint, ShieldCheck, Sparkles } from "lucide-react";
import { Link } from "react-router";

import { ProductBrand } from "../component/ProductBrand";
import { AuthPage } from "../features/auth/AuthPage";

export default function LoginPage() {
  return (
    <main className="login-page" data-testid="login-page">
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
          <h1 className="mt-5 max-w-lg text-[clamp(32px,4vw,48px)] font-semibold leading-[1.25] tracking-[-0.06em] text-ink">
            身份验证，
            <span className="text-accent block">无需记住密码</span>
          </h1>
          <p className="mt-5 max-w-md text-sm leading-7 text-muted">
            Passkey 使用设备生物识别或安全密钥验证身份。凭证不会离开你的设备，登录更快，也更不容易被钓鱼。
          </p>

          <div className="auth-story__features">
            <StoryFeature icon={Fingerprint} label="设备原生验证" />
            <StoryFeature icon={ShieldCheck} label="抗钓鱼凭证" />
            <StoryFeature icon={Sparkles} label="一触即达" />
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
