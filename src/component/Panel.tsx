import type { ReactNode } from "react";

export function Panel({
  children,
  className = "",
  testId = "panel",
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section
      className={`min-w-0 rounded-lg border border-[#d7e5f6] bg-white ${className}`}
      data-testid={testId}
    >
      {children}
    </section>
  );
}
