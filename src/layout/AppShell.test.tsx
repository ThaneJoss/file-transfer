import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AppShell, routes } from "./AppShell";

function CurrentPath() {
  const location = useLocation();
  return <span data-testid="current-path">{location.pathname}</span>;
}

function renderShell(initialPath = "/direct") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AppShell>
        <Routes>
          {routes.map((route) => (
            <Route element={<h1>{route.label} 页面</h1>} key={route.id} path={route.path} />
          ))}
        </Routes>
        <CurrentPath />
      </AppShell>
    </MemoryRouter>,
  );
}

describe("AppShell navigation", () => {
  it("updates active nav state and slider position through user clicks", async () => {
    const user = userEvent.setup();
    renderShell("/direct");

    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
    expect(screen.getByTestId("page-slot")).toContainElement(screen.getByRole("heading", { name: "Direct 页面" }));
    expect(screen.getByTestId("nav-item-direct")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("nav-active-indicator")).toHaveStyle({ transform: "translateX(0%)" });

    await user.click(screen.getByTestId("nav-item-sfu"));

    expect(screen.getByTestId("current-path")).toHaveTextContent("/sfu");
    expect(screen.getByRole("heading", { name: "SFU 页面" })).toBeVisible();
    expect(screen.getByTestId("nav-item-sfu")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("nav-item-direct")).not.toHaveAttribute("aria-current");
    expect(screen.getByTestId("nav-active-indicator")).toHaveStyle({ transform: "translateX(300%)" });
  });

  it("keeps the brand link routed to Direct", async () => {
    const user = userEvent.setup();
    renderShell("/r2");

    expect(screen.getByTestId("nav-item-r2")).toHaveAttribute("aria-current", "page");
    await user.click(screen.getByLabelText("文件中转站首页"));

    expect(screen.getByTestId("current-path")).toHaveTextContent("/direct");
    expect(screen.getByTestId("nav-item-direct")).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "Direct 页面" })).toBeVisible();
  });
});
