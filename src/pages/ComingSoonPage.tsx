import { Gauge } from "lucide-react";

import { Panel } from "../components/Panel";

export function ComingSoonPage({ title }: { title: string }) {
  return (
    <Panel className="grid min-h-0 flex-1 place-items-center overflow-hidden p-[clamp(18px,2vw,32px)] text-center">
      <div className="grid max-w-[520px] justify-items-center gap-5">
        <span className="grid size-[72px] place-items-center rounded-2xl bg-[#1677ff] text-white shadow-[0_14px_30px_rgba(47,125,246,0.24)]">
          <Gauge aria-hidden="true" size={34} />
        </span>
        <div>
          <h1 className="text-[clamp(26px,3vw,42px)] font-extrabold text-[#061b3a]">{title}</h1>
          <p className="mt-3 text-[16px] leading-7 text-[#526c92]">
            这个传输模式的页面入口已经独立，后续可以在这里接入对应的连接流程和状态面板。
          </p>
        </div>
      </div>
    </Panel>
  );
}
