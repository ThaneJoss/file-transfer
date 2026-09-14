import { Check, Hash, RadioTower, Zap } from "lucide-react";


export function TransferHero() {
  return (
    <section className="transfer-hero" aria-labelledby="transfer-title">
      <div className="transfer-hero__copy">
        <div className="eyebrow">
          <span className="eyebrow__signal" aria-hidden="true" />
          简单、安全地分享文件
        </div>
        <h1
          aria-label="传文件，只需要一个取件码"
          className="home-transfer-title mt-4 max-w-xl text-[clamp(28px,3vw,40px)] font-semibold leading-[1.25] tracking-[-0.055em] text-ink"
          id="transfer-title"
        >
          <span className="block">传文件，</span>
          <span className="block">只需要一个取件码</span>
        </h1>
        <p className="home-transfer-subtitle mt-4 max-w-xl text-sm leading-6 text-muted sm:text-[15px]">
          五条线路实时竞速，自动选择更快路径。无需复杂配置，用 8 位取件码完成连接、传输与完整性校验。
        </p>
      </div>

      <div className="transfer-proof-grid" aria-label="传输能力">
        <Proof icon={Zap} label="实时选路" value="5 条链路" />
        <Proof icon={Hash} label="完整性" value="SHA-256" />
        <Proof icon={RadioTower} label="接收方式" value="访客可用" />
      </div>

      <div className="transfer-flow" aria-label="传输流程">
        <FlowStep index="01" label="选择文件" />
        <span className="transfer-flow__line" aria-hidden="true" />
        <FlowStep index="02" label="分享取件码" />
        <span className="transfer-flow__line" aria-hidden="true" />
        <FlowStep index="03" label="校验完成" />
      </div>
    </section>
  );
}

function Proof({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Check;
  label: string;
  value: string;
}) {
  return (
    <div className="transfer-proof">
      <span className="transfer-proof__icon">
        <Icon aria-hidden="true" size={15} />
      </span>
      <span>
        <span className="block font-mono text-xs font-bold tracking-[0.12em] text-muted uppercase">{label}</span>
        <strong className="mt-1 block text-xs font-semibold text-ink">{value}</strong>
      </span>
    </div>
  );
}

function FlowStep({ index, label }: { index: string; label: string }) {
  return (
    <span className="transfer-flow__step">
      <i>{index}</i>
      <span>{label}</span>
    </span>
  );
}
