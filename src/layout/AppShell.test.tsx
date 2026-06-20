import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AppShell } from "./AppShell";

function CurrentPath() {
  const location = useLocation();
  return <span data-testid="current-path">{location.pathname}</span>;
}

function renderShell(initialPath = "/") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AppShell>
        <Routes>
          <Route element={<h1>首页</h1>} path="/" />
          <Route element={<h1>账户</h1>} path="/account" />
        </Routes>
        <CurrentPath />
      </AppShell>
    </MemoryRouter>,
  );
}

describe("AppShell navigation", () => {
  it("renders the shell without method navigation", async () => {
    renderShell("/");
    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
    expect(screen.getByTestId("page-slot")).toContainElement(screen.getByRole("heading", { name: "首页" }));
    expect(screen.queryByTestId("app-nav")).not.toBeInTheDocument();
  });

  it("keeps the brand link routed to the home page", async () => {
    const user = userEvent.setup();
    renderShell("/account");

    await user.click(screen.getByLabelText("文件中转站首页"));

    expect(screen.getByTestId("current-path")).toHaveTextContent("/");
    expect(screen.getByRole("heading", { name: "首页" })).toBeVisible();
  });
});
