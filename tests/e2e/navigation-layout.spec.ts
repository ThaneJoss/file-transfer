import { test, expect } from "@playwright/test";

import {
  collectConsoleErrors,
  expectActiveNav,
  expectNoConsoleErrors,
  expectNoHorizontalOverflow,
  expectRectStable,
  expectSliderAligned,
  getLayoutMetrics,
  installAppMocks,
  openRoute,
  routeIds,
  routePath,
  type RouteId,
} from "./support/app";

const viewports = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

for (const viewport of viewports) {
  test.describe(`navigation layout ${viewport.width}x${viewport.height}`, () => {
    let consoleErrors: string[];

    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
      consoleErrors = collectConsoleErrors(page);
      await installAppMocks(page);
    });

    test.afterEach(async () => {
      await expectNoConsoleErrors(consoleErrors);
    });

    test("keeps shell, header, nav, content slot and first panel stable for all directed route switches", async ({ page }) => {
      for (const from of routeIds) {
        await openRoute(page, from);
        const before = await getLayoutMetrics(page);

        for (const to of routeIds.filter((route): route is RouteId => route !== from)) {
          await page.getByTestId(`nav-item-${to}`).click();
          await expect(page).toHaveURL(routePath[to]);
          await expectActiveNav(page, to);
          const after = await getLayoutMetrics(page);

          expectRectStable(before, after, ["shell", "header", "nav", "pageSlot"]);
          expect(after.firstPanel.top, `${from}->${to} first panel top`).toBeCloseTo(before.firstPanel.top, 0);
          await expectSliderAligned(page);
          await expectNoHorizontalOverflow(page);

          await page.goto(routePath[from]);
          await expectActiveNav(page, from);
        }
      }
    });

    test("supports browser back and forward without moving shared layout", async ({ page }) => {
      await openRoute(page, "direct");
      const before = await getLayoutMetrics(page);
      await page.getByTestId("nav-item-stun").click();
      await page.getByTestId("nav-item-turn").click();

      await page.goBack();
      await expect(page).toHaveURL(routePath.stun);
      expectRectStable(before, await getLayoutMetrics(page), ["shell", "header", "nav", "pageSlot"]);

      await page.goBack();
      await expect(page).toHaveURL(routePath.direct);
      expectRectStable(before, await getLayoutMetrics(page), ["shell", "header", "nav", "pageSlot"]);

      await page.goForward();
      await expect(page).toHaveURL(routePath.stun);
      await expectSliderAligned(page);
    });

    test("handles rapid route clicks and repeated current-route clicks", async ({ page }) => {
      await openRoute(page, "direct");
      const before = await getLayoutMetrics(page);

      for (const id of ["stun", "turn", "sfu", "r2"] as const) {
        await page.getByTestId(`nav-item-${id}`).click();
      }
      await expect(page).toHaveURL(routePath.r2);
      expectRectStable(before, await getLayoutMetrics(page), ["shell", "header", "nav", "pageSlot"]);
      await expectSliderAligned(page);

      const repeatBefore = await getLayoutMetrics(page);
      await page.getByTestId("nav-item-r2").click();
      await expect(page).toHaveURL(routePath.r2);
      expectRectStable(repeatBefore, await getLayoutMetrics(page), ["shell", "header", "nav", "pageSlot"]);
    });

    test("keeps shared layout stable when vertical scrollbar state is forced", async ({ page }) => {
      await openRoute(page, "direct");
      const before = await getLayoutMetrics(page);
      await page.evaluate(() => {
        const filler = document.createElement("div");
        filler.id = "scroll-filler";
        filler.style.height = "1800px";
        document.body.append(filler);
      });
      const withScrollbar = await getLayoutMetrics(page);
      expectRectStable(before, withScrollbar, ["shell", "header", "nav", "pageSlot"]);

      await page.getByTestId("nav-item-r2").click();
      await expect(page).toHaveURL(routePath.r2);
      expectRectStable(withScrollbar, await getLayoutMetrics(page), ["shell", "header", "nav", "pageSlot"]);

      await page.evaluate(() => document.querySelector("#scroll-filler")?.remove());
      expectRectStable(before, await getLayoutMetrics(page), ["shell", "header", "nav", "pageSlot"]);
      await expectNoHorizontalOverflow(page);
    });
  });
}
