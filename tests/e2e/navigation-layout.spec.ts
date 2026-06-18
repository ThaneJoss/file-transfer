import { test, expect } from "@playwright/test";

import {
  collectConsoleErrors,
  expectActiveNav,
  expectNoConsoleErrors,
  expectNoHorizontalOverflow,
  expectNoLayoutOverflow,
  expectRectStable,
  expectSharedPanelsVisible,
  expectSliderAligned,
  getLayoutMetrics,
  installAppMocks,
  openRoute,
  routeIds,
  routePath,
  type RouteId,
  waitForLayoutStable,
} from "./support/app";

const viewports = [
  { width: 1920, height: 868 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
];

const stableGeometryViewports = [
  { width: 1920, height: 868 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
];

const stableLayoutKeys = [
  "brand",
  "header",
  "nav",
  "pageSlot",
  "workspace",
  "statusPanel",
  "targetPanel",
  "uploadPanel",
  "fileListPanel",
  "uploadDropzone",
] as const;

for (const viewport of viewports) {
  test.describe(`route accessibility and overflow ${viewport.width}x${viewport.height}`, () => {
    let consoleErrors: string[];

    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
      consoleErrors = collectConsoleErrors(page);
      await installAppMocks(page);
    });

    test.afterEach(async () => {
      await expectNoConsoleErrors(consoleErrors);
    });

    test("renders every route with shared panels and no horizontal overflow", async ({ page }) => {
      for (const route of routeIds) {
        await openRoute(page, route);
        await waitForLayoutStable(page);
        await expectActiveNav(page, route);
        await expectSharedPanelsVisible(page);
        await expectSliderAligned(page);
        await expectNoLayoutOverflow(page);
      }
    });
  });
}

for (const viewport of stableGeometryViewports) {
  test.describe(`navigation layout stability ${viewport.width}x${viewport.height}`, () => {
    let consoleErrors: string[];

    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
      consoleErrors = collectConsoleErrors(page);
      await installAppMocks(page);
    });

    test.afterEach(async () => {
      await expectNoConsoleErrors(consoleErrors);
    });

    test("keeps shared shell and workspace geometry stable through two full route cycles", async ({ page }) => {
      const sequence: RouteId[] = ["stun", "turn", "sfu", "r2", "direct"];
      await openRoute(page, "direct");
      await waitForLayoutStable(page);
      const baseline = await getLayoutMetrics(page);

      for (let cycle = 0; cycle < 2; cycle += 1) {
        for (const route of sequence) {
          await page.getByTestId(`nav-item-${route}`).click();
          await expect(page).toHaveURL(routePath[route]);
          await expectActiveNav(page, route);
          await waitForLayoutStable(page);
          expectRectStable(baseline, await getLayoutMetrics(page), [...stableLayoutKeys]);
          await expectSliderAligned(page);
          await expectNoHorizontalOverflow(page);
        }
      }
    });

    test("supports browser back and forward without moving shared layout", async ({ page }) => {
      await openRoute(page, "direct");
      await waitForLayoutStable(page);
      const before = await getLayoutMetrics(page);
      await page.getByTestId("nav-item-stun").click();
      await waitForLayoutStable(page);
      await page.getByTestId("nav-item-turn").click();
      await waitForLayoutStable(page);

      await page.goBack();
      await expect(page).toHaveURL(routePath.stun);
      await waitForLayoutStable(page);
      expectRectStable(before, await getLayoutMetrics(page), [...stableLayoutKeys]);

      await page.goBack();
      await expect(page).toHaveURL(routePath.direct);
      await waitForLayoutStable(page);
      expectRectStable(before, await getLayoutMetrics(page), [...stableLayoutKeys]);

      await page.goForward();
      await expect(page).toHaveURL(routePath.stun);
      await waitForLayoutStable(page);
      await expectSliderAligned(page);
    });

    test("handles rapid route clicks and repeated current-route clicks", async ({ page }) => {
      await openRoute(page, "direct");
      await waitForLayoutStable(page);
      const before = await getLayoutMetrics(page);

      for (const id of ["stun", "turn", "sfu", "r2"] as const) {
        await page.getByTestId(`nav-item-${id}`).click();
      }
      await expect(page).toHaveURL(routePath.r2);
      await waitForLayoutStable(page);
      expectRectStable(before, await getLayoutMetrics(page), [...stableLayoutKeys]);
      await expectSliderAligned(page);

      const repeatBefore = await getLayoutMetrics(page);
      await page.getByTestId("nav-item-r2").click();
      await expect(page).toHaveURL(routePath.r2);
      await waitForLayoutStable(page);
      expectRectStable(repeatBefore, await getLayoutMetrics(page), [...stableLayoutKeys]);
    });

    test("keeps shared layout stable when vertical scrollbar state is forced", async ({ page }) => {
      await openRoute(page, "direct");
      await waitForLayoutStable(page);
      const before = await getLayoutMetrics(page);
      await page.evaluate(() => {
        const filler = document.createElement("div");
        filler.id = "scroll-filler";
        filler.style.height = "1800px";
        document.body.append(filler);
      });
      await waitForLayoutStable(page);
      const withScrollbar = await getLayoutMetrics(page);
      expectRectStable(before, withScrollbar, [...stableLayoutKeys]);

      await page.getByTestId("nav-item-r2").click();
      await expect(page).toHaveURL(routePath.r2);
      await waitForLayoutStable(page);
      expectRectStable(withScrollbar, await getLayoutMetrics(page), [...stableLayoutKeys]);

      await page.evaluate(() => document.querySelector("#scroll-filler")?.remove());
      await waitForLayoutStable(page);
      expectRectStable(before, await getLayoutMetrics(page), [...stableLayoutKeys]);
      await expectNoHorizontalOverflow(page);
    });
  });
}

test.describe("visual regression snapshots", () => {
  let consoleErrors: string[];

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 868 });
    consoleErrors = collectConsoleErrors(page);
    await installAppMocks(page);
  });

  test.afterEach(async () => {
    await expectNoConsoleErrors(consoleErrors);
  });

  for (const route of routeIds) {
    test(`${route} desktop layout snapshot`, async ({ page }) => {
      await openRoute(page, route);
      await waitForLayoutStable(page);
      await expectSharedPanelsVisible(page);
      await expect(page).toHaveScreenshot(`${route}-1920x868.png`, {
        animations: "disabled",
        fullPage: true,
        maxDiffPixelRatio: 0.005,
      });
    });
  }
});
