import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProgressCard } from "./TransferFeedback";

describe("ProgressCard", () => {
  it("exposes the visible transfer phase and bounded progress to assistive technology", () => {
    const { rerender } = render(<ProgressCard label="准备进度" progress={-1} testId="progress" />);
    expect(screen.getByRole("progressbar", { name: "准备进度" })).toHaveAttribute("aria-valuenow", "0");

    rerender(<ProgressCard label="传输进度" progress={42.4} testId="progress" />);
    expect(screen.getByRole("progressbar", { name: "传输进度" })).toHaveAttribute("aria-valuenow", "42");

    rerender(<ProgressCard label="传输进度" progress={101} testId="progress" />);
    expect(screen.getByRole("progressbar", { name: "传输进度" })).toHaveAttribute("aria-valuenow", "100");
  });
});
