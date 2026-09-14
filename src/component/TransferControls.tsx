import type { ReactNode } from "react";

export function TextInput({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  min,
  max,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "email" | "password" | "number";
  min?: number;
  max?: number;
  autoComplete?: string;
}) {
  return (
    <label className="grid min-w-0 gap-2">
      <span className="min-w-0 truncate text-xs font-semibold tracking-[0.08em] text-muted uppercase" title={label}>{label}</span>
      <input
        className="form-input h-12 min-w-0 px-4 text-[14px] font-semibold"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type={type}
        min={min}
        max={max}
        autoComplete={autoComplete}
        spellCheck={false}
      />
    </label>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled = false,
  type = "button",
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  return (
    <button
      className={`button-primary inline-flex min-h-11 max-w-full min-w-0 items-center justify-center gap-2 px-5 text-center text-[14px] font-semibold [overflow-wrap:anywhere] ${className}`}
      type={type}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  onClick,
  disabled = false,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      className={`button-secondary inline-flex min-h-11 max-w-full min-w-0 items-center justify-center gap-2 px-4 text-center text-[14px] font-semibold [overflow-wrap:anywhere] ${className}`}
      type="button"
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function StatusMessage({
  message,
  tone,
}: {
  message: string;
  tone: "error" | "info";
}) {
  return (
    <p
      aria-live={tone === "error" ? "assertive" : "polite"}
      className={`flex min-h-11 min-w-0 items-center overflow-hidden rounded-xl border px-4 text-[13px] font-semibold ${
        tone === "error"
          ? "border-danger/25 bg-danger/10 text-danger"
          : "border-primary/20 bg-primary/10 text-primary-strong"
      }`}
      role={tone === "error" ? "alert" : "status"}
      title={message}
    >
      <span className="block min-w-0 truncate">{message}</span>
    </p>
  );
}
