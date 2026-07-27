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
      className={`surface-panel min-w-0 ${className}`}
      data-testid={testId}
    >
      {children}
    </section>
  );
}
