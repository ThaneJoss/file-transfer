import type { ReactNode } from "react";

export function TextArea({
  label,
  value,
  onChange,
  placeholder,
  readOnly = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  readOnly?: boolean;
}) {
  return (
    <label className="grid min-w-0 gap-2">
      <span className="min-w-0 truncate text-sm font-extrabold text-[#233d64]" title={label}>{label}</span>
      <textarea
        className={`h-[clamp(88px,10.5dvh,118px)] min-h-0 min-w-0 resize-none rounded-xl border border-[#d7e5f6] px-3 py-3 font-mono text-[12px] leading-relaxed text-[#17345f] outline-none transition placeholder:text-[#91a4c0] focus:border-[#1677ff] focus:ring-4 focus:ring-[#1677ff]/10 max-[1180px]:h-[128px] max-[560px]:h-[116px] ${
          readOnly ? "bg-[#f7fbff]" : "bg-white"
        }`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        readOnly={readOnly}
        spellCheck={false}
      />
    </label>
  );
}

export function TextInput({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  min,
  max,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "password" | "number";
  min?: number;
  max?: number;
}) {
  return (
    <label className="grid min-w-0 gap-2">
      <span className="min-w-0 truncate text-sm font-extrabold text-[#233d64]" title={label}>{label}</span>
      <input
        className="h-11 min-w-0 rounded-lg border border-[#d7e5f6] bg-white px-3 text-[14px] font-semibold text-[#17345f] outline-none transition placeholder:text-[#91a4c0] focus:border-[#1677ff] focus:ring-4 focus:ring-[#1677ff]/10"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type={type}
        min={min}
        max={max}
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
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      className="inline-flex min-h-11 max-w-full min-w-0 items-center justify-center gap-2 rounded-lg bg-[#1677ff] px-5 text-center text-[15px] font-extrabold text-white shadow-[0_12px_22px_rgba(47,125,246,0.22)] transition [overflow-wrap:anywhere] hover:-translate-y-px hover:bg-[#0d63da] disabled:cursor-not-allowed disabled:bg-[#a9bdd8] disabled:shadow-none disabled:hover:translate-y-0"
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
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="inline-flex min-h-11 max-w-full min-w-0 items-center justify-center gap-2 rounded-lg border border-[#d7e5f6] bg-white px-4 text-center text-[15px] font-extrabold text-[#17345f] transition [overflow-wrap:anywhere] hover:-translate-y-px hover:border-[#9ec7ff] disabled:cursor-not-allowed disabled:text-[#98a9c0] disabled:hover:translate-y-0"
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
      className={`flex h-11 min-w-0 items-center overflow-hidden rounded-xl px-4 text-[14px] ${
        tone === "error" ? "bg-[#fff0f0] text-[#b4232b]" : "bg-[#edf6ff] text-[#365a88]"
      }`}
      role={tone === "error" ? "alert" : "status"}
      title={message}
    >
      <span className="block min-w-0 truncate">{message}</span>
    </p>
  );
}
