import type { ReactNode } from "react";

export function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-white/70 bg-white/90 shadow-[0_18px_55px_rgba(23,54,97,0.10)] ring-1 ring-[#d9e7f8]/70 backdrop-blur ${className}`}
    >
      {children}
    </section>
  );
}
