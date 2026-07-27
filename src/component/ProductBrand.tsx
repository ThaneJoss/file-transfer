import { Link } from "react-router";

export function ProductBrand({
  ariaLabel = "文件中转站首页",
  testId,
  to = "/",
}: {
  ariaLabel?: string;
  testId?: string;
  to?: string;
}) {
  return (
    <Link
      className="product-brand"
      to={to}
      aria-label={ariaLabel}
      data-testid={testId}
    >
      <BrandMark />
      <span className="min-w-0">
        <strong className="block truncate text-[15px] font-black tracking-[-0.01em] text-ink sm:text-base">
          文件中转站
        </strong>
        <span className="mt-0.5 block truncate font-mono text-[9px] font-bold tracking-[0.2em] text-muted uppercase">
          Edge transfer
        </span>
      </span>
    </Link>
  );
}

export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 44 44" role="presentation">
        <path className="brand-mark__orbit" d="M9 14.5 22 7l13 7.5v15L22 37 9 29.5Z" />
        <path className="brand-mark__route" d="m14.5 24 5-5 4.5 4.5 5.5-6" />
        <circle className="brand-mark__node" cx="14.5" cy="24" r="2" />
        <circle className="brand-mark__node" cx="29.5" cy="17.5" r="2" />
      </svg>
    </span>
  );
}
