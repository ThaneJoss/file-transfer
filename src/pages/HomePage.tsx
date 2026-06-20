import { LockKeyhole, LogIn } from "lucide-react";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { Panel } from "../component/Panel";
import { SfuTransferPage } from "../features/sfu/SfuTransferPage";
import { R2TransferPage } from "../features/r2/R2TransferPage";
import { TransferPage } from "../features/transfer/TransferPage";
import type { WebRtcTransferVariant } from "../features/transfer/TransferPage";
import type { PendingPickup, PickupVariant } from "../features/transfer/services/pickupApi";
import { useAuth } from "../lib/auth/AuthProvider";

type TransferMethod = PickupVariant;

const transferMethods: Array<{
  id: TransferMethod;
  label: string;
  description: string;
}> = [
  { id: "direct", label: "Direct", description: "局域网/直连" },
  { id: "stun", label: "STUN", description: "公网 P2P" },
  { id: "turn", label: "TURN", description: "中继 DataChannel" },
  { id: "sfu", label: "SFU", description: "服务端转发" },
  { id: "r2", label: "R2", description: "对象存储" },
];

const protectedMethods = new Set<TransferMethod>(["turn", "sfu", "r2"]);

function isWebRtcMethod(method: TransferMethod): method is WebRtcTransferVariant {
  return method === "direct" || method === "stun" || method === "turn";
}

export default function HomePage() {
  const { session } = useAuth();
  const [method, setMethod] = useState<TransferMethod>("direct");
  const [pendingPickup, setPendingPickup] = useState<PendingPickup | null>(null);

  const methodSelector = useMemo(
    () => (
      <TransferMethodSelector
        value={method}
        onChange={(nextMethod) => {
          setMethod(nextMethod);
          setPendingPickup(null);
        }}
      />
    ),
    [method],
  );

  const handlePickupVariantResolved = (pending: PendingPickup) => {
    setPendingPickup(pending);
    setMethod(pending.pickup.variant);
  };

  if (!session?.user && protectedMethods.has(method)) {
    return <ProtectedMethodNotice method={method} methodSelector={methodSelector} />;
  }

  if (isWebRtcMethod(method)) {
    return (
      <TransferPage
        key={method}
        variant={method}
        methodSelector={methodSelector}
        pendingPickup={pendingPickup}
        onPickupVariantResolved={handlePickupVariantResolved}
      />
    );
  }

  if (method === "sfu") {
    return (
      <SfuTransferPage
        key={method}
        methodSelector={methodSelector}
        pendingPickup={pendingPickup}
        onPickupVariantResolved={handlePickupVariantResolved}
      />
    );
  }

  return (
    <R2TransferPage
      key={method}
      methodSelector={methodSelector}
      pendingPickup={pendingPickup}
      onPickupVariantResolved={handlePickupVariantResolved}
    />
  );
}

function TransferMethodSelector({
  value,
  onChange,
}: {
  value: TransferMethod;
  onChange: (method: TransferMethod) => void;
}) {
  return (
    <div className="rounded-xl border border-[#d7e5f6] bg-[#f7fbff] p-3" data-testid="transfer-method-selector">
      <div className="mb-2 text-sm font-extrabold text-[#233d64]">传输方法</div>
      <div className="grid grid-cols-5 gap-1.5 max-[560px]:grid-cols-2">
        {transferMethods.map((method) => {
          const active = method.id === value;
          return (
            <button
              key={method.id}
              type="button"
              onClick={() => onChange(method.id)}
              className={`min-w-0 rounded-lg border px-2 py-2 text-left transition ${
                active
                  ? "border-[#1677ff] bg-[#1677ff] text-white shadow-[0_8px_18px_rgba(47,125,246,0.18)]"
                  : "border-[#d7e5f6] bg-white text-[#355176] hover:border-[#9ec7ff]"
              }`}
              aria-pressed={active}
              data-testid={`method-option-${method.id}`}
            >
              <span className="block truncate text-[13px] font-extrabold">{method.label}</span>
              <span className={`mt-0.5 block truncate text-[11px] ${active ? "text-white/80" : "text-[#6b7f9d]"}`}>
                {method.description}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ProtectedMethodNotice({
  method,
  methodSelector,
}: {
  method: TransferMethod;
  methodSelector: ReactNode;
}) {
  const label = transferMethods.find((item) => item.id === method)?.label ?? method.toUpperCase();
  return (
    <div className="mx-auto grid w-full max-w-[760px] gap-4 py-8">
      <Panel className="p-6">
        <div className="grid gap-4">
          <div className="flex items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-[#eaf2ff] text-[#1677ff]">
              <LockKeyhole aria-hidden="true" size={22} />
            </span>
            <div className="min-w-0">
              <h1 className="text-[24px] font-extrabold text-[#061b3a]">{label} 需要登录</h1>
              <p className="mt-1 text-sm text-[#526c92]">
                TURN、SFU 和 R2 会使用服务端临时凭证和 Durable 取件码，需要登录后使用。
              </p>
            </div>
          </div>
          {methodSelector}
          <Link
            className="inline-flex w-fit items-center gap-2 rounded-xl bg-[#1677ff] px-4 py-3 text-sm font-extrabold text-white"
            to="/login"
          >
            <LogIn aria-hidden="true" size={17} />
            登录
          </Link>
        </div>
      </Panel>
    </div>
  );
}
