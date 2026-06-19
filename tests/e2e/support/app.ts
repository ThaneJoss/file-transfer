import { expect, type Page } from "@playwright/test";

export const routeIds = ["direct", "stun", "turn", "sfu", "r2"] as const;
export type RouteId = (typeof routeIds)[number];

export const routePath: Record<RouteId, string> = {
  direct: "/direct",
  stun: "/stun",
  turn: "/turn",
  sfu: "/sfu",
  r2: "/r2",
};

export const apiBaseUrl = "https://api.file.thanejoss.com";

export function testAuthSession() {
  return {
    session: {
      id: "session-test",
      userId: "user-test",
      token: "cookie-session-token",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    user: {
      id: "user-test",
      name: "测试用户",
      email: "user@example.com",
      emailVerified: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

export type SignalKind = "direct-webrtc-signal" | "stun-webrtc-signal" | "turn-webrtc-signal";
export type CandidateType = "host" | "srflx" | "relay";

export async function decodeConnectionCodePayload(page: Page, code: string) {
  return page.evaluate(async (value) => {
    const base64UrlToBytes = (input: string) => {
      const base64 = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
      return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    };
    let json: string;
    if (value.startsWith("D1.")) {
      const stream = new Blob([base64UrlToBytes(value.slice(3))]).stream().pipeThrough(new DecompressionStream("gzip"));
      json = await new Response(stream).text();
    } else if (value.startsWith("J1.")) {
      json = new TextDecoder().decode(base64UrlToBytes(value.slice(3)));
    } else {
      json = value;
    }
    return JSON.parse(json) as Record<string, unknown>;
  }, code);
}

const testCandidateByType: Record<CandidateType, string> = {
  host: "candidate:1 1 udp 2122260223 192.168.0.2 52102 typ host",
  srflx: "candidate:2 1 udp 1686052607 203.0.113.10 42102 typ srflx raddr 192.168.0.2 rport 52102",
  relay: "candidate:3 1 udp 41819903 198.51.100.20 3478 typ relay raddr 0.0.0.0 rport 0",
};

export function rawSignalText({
  kind,
  role,
  descriptionType,
  candidateTypes = ["host"],
}: {
  kind: SignalKind;
  role: "offer" | "answer";
  descriptionType: RTCSdpType;
  candidateTypes?: CandidateType[];
}) {
  const candidates = candidateTypes.map((type) => testCandidateByType[type]);
  const sdp = [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    "a=mid:0",
    "a=sctp-port:5000",
    ...candidates.map((candidate) => `a=${candidate}`),
    "a=end-of-candidates",
    "",
  ].join("\r\n");

  return JSON.stringify({
    kind,
    role,
    description: {
      type: descriptionType,
      sdp,
    },
    candidates: candidates.map((candidate) => ({
      candidate,
      sdpMid: "0",
      sdpMLineIndex: 0,
    })),
    createdAt: Date.now(),
  });
}

export function collectConsoleErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      errors.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (!url.startsWith("http://127.0.0.1")) return;
    const errorText = request.failure()?.errorText ?? "";
    if (errorText === "net::ERR_ABORTED") return;
    errors.push(`requestfailed: ${request.method()} ${url} ${errorText}`);
  });
  return errors;
}

export async function expectNoConsoleErrors(errors: string[]) {
  expect(errors).toEqual([]);
}

export function withoutExpectedNetworkDiagnostics(errors: string[]) {
  return errors.filter(
    (message) =>
      !/Failed to load resource: the server responded with a status of (401|403|429|500)/.test(message) &&
      !message.includes("net::ERR_FAILED"),
  );
}

export async function installAppMocks(
  page: Page,
  options: {
    candidateTypes?: Array<"host" | "srflx" | "relay">;
    dataChannelState?: RTCDataChannelState;
    dataChannelFailure?: "close" | "error";
  } = {},
) {
  await page.route(`${apiBaseUrl}/api/auth/get-session`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(testAuthSession()) }),
  );
  await page.route(`${apiBaseUrl}/api/auth/sign-out`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ success: true }) }),
  );
  await page.route(`${apiBaseUrl}/v1/usage`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        summary: [
          { service: "turn", action: "credential.issued", events: 2, quantity: 2 },
          { service: "r2", action: "credential.issued", events: 3, quantity: 3 },
          { service: "sfu", action: "session.create", events: 4, quantity: 4 },
        ],
      }),
    }),
  );

  await page.addInitScript(({ candidateTypes, dataChannelState, dataChannelFailure }) => {
    const selectedTypes = candidateTypes.length ? candidateTypes : ["host", "srflx", "relay"];
    const candidateByType: Record<string, string> = {
      host: "candidate:1 1 udp 2122260223 192.168.0.2 52102 typ host",
      srflx: "candidate:2 1 udp 1686052607 203.0.113.10 42102 typ srflx raddr 192.168.0.2 rport 52102",
      relay: "candidate:3 1 udp 41819903 198.51.100.20 3478 typ relay raddr 0.0.0.0 rport 0",
    };
    const candidateLines = selectedTypes.map((type) => `a=${candidateByType[type]}`).join("\r\n");
    const sdp = [
      "v=0",
      "o=- 0 0 IN IP4 127.0.0.1",
      "s=-",
      "t=0 0",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
      "c=IN IP4 0.0.0.0",
      "a=mid:0",
      "a=sctp-port:5000",
      candidateLines,
      "a=end-of-candidates",
      "",
    ].join("\r\n");

    type Listener = (event: Event) => void;

    class FakeDataChannel extends EventTarget {
      binaryType: BinaryType = "arraybuffer";
      bufferedAmount = 0;
      bufferedAmountLowThreshold = 0;
      readyState: RTCDataChannelState = dataChannelState;

      constructor(public label: string) {
        super();
      }

      send(data: unknown) {
        window.__appTest.rtc.sentPayloads.push(
          data instanceof ArrayBuffer
            ? { kind: "arrayBuffer", byteLength: data.byteLength }
            : { kind: "text", value: String(data) },
        );
        this.bufferedAmount = 0;
      }

      close() {
        if (this.readyState === "closed") return;
        this.readyState = "closed";
        window.__appTest.rtc.closedChannels += 1;
        this.dispatchEvent(new Event("close"));
      }

      addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
        super.addEventListener(type, listener as Listener, options);
      }

      removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
        super.removeEventListener(type, listener as Listener, options);
      }
    }

    class FakePeerConnection extends EventTarget {
      connectionState: RTCPeerConnectionState = "new";
      iceConnectionState: RTCIceConnectionState = "new";
      iceGatheringState: RTCIceGatheringState = "new";
      localDescription: RTCSessionDescriptionInit | null = null;
      remoteDescription: RTCSessionDescriptionInit | null = null;
      signalingState: RTCSignalingState = "stable";

      constructor(public config: RTCConfiguration = {}) {
        super();
        window.__appTest.rtc.createdConfigs.push(config);
      }

      createDataChannel(label: string) {
        const channel = new FakeDataChannel(label) as unknown as RTCDataChannel;
        window.__appTest.rtc.createdChannels += 1;
        window.__appTest.rtc.channels.push(channel as unknown as FakeDataChannel);
        return channel;
      }

      makeDescription(type: RTCSdpType) {
        return {
          type,
          sdp,
          toJSON() {
            return { type, sdp };
          },
        };
      }

      async createOffer() {
        return this.makeDescription("offer");
      }

      async createAnswer() {
        return this.makeDescription("answer");
      }

      async setLocalDescription(description: RTCSessionDescriptionInit) {
        this.localDescription = description;
        this.iceGatheringState = "complete";
        this.dispatchEvent(new Event("icegatheringstatechange"));
      }

      async setRemoteDescription(description: RTCSessionDescriptionInit) {
        this.remoteDescription = description;
        this.connectionState = dataChannelFailure ? "connecting" : "connected";
        this.iceConnectionState = dataChannelFailure ? "checking" : "connected";
        this.dispatchEvent(new Event("connectionstatechange"));
        this.dispatchEvent(new Event("iceconnectionstatechange"));
        if (dataChannelFailure) {
          window.setTimeout(() => {
            for (const channel of window.__appTest.rtc.channels) {
              if (dataChannelFailure === "close") channel.close();
              else channel.dispatchEvent(new Event("error"));
            }
          }, 0);
        } else if (dataChannelState !== "open") {
          window.setTimeout(() => {
            for (const channel of window.__appTest.rtc.channels) {
              if (channel.readyState !== "connecting") continue;
              channel.readyState = "open";
              channel.dispatchEvent(new Event("open"));
            }
          }, 0);
        }
      }

      async addIceCandidate() {
        return undefined;
      }

      async getStats() {
        return new Map<string, RTCStats>([
          ["transport", { id: "transport", timestamp: performance.now(), type: "transport", selectedCandidatePairId: "pair" } as RTCStats],
          [
            "pair",
            {
              id: "pair",
              timestamp: performance.now(),
              type: "candidate-pair",
              nominated: true,
              state: "succeeded",
              localCandidateId: "local",
              remoteCandidateId: "remote",
              currentRoundTripTime: 0.012,
            } as RTCStats,
          ],
          [
            "local",
            {
              id: "local",
              timestamp: performance.now(),
              type: "local-candidate",
              candidateType: selectedTypes.includes("relay") ? "relay" : selectedTypes[0],
              protocol: "udp",
              relayProtocol: selectedTypes.includes("relay") ? "udp" : undefined,
              address: "198.51.100.20",
              port: 3478,
            } as RTCStats,
          ],
          [
            "remote",
            {
              id: "remote",
              timestamp: performance.now(),
              type: "remote-candidate",
              candidateType: "host",
              protocol: "udp",
              address: "203.0.113.10",
              port: 42102,
            } as RTCStats,
          ],
        ]);
      }

      close() {
        this.connectionState = "closed";
        this.iceConnectionState = "closed";
        window.__appTest.rtc.closedPeers += 1;
        this.dispatchEvent(new Event("connectionstatechange"));
        this.dispatchEvent(new Event("iceconnectionstatechange"));
      }
    }

    window.__appTest = {
      rtc: {
        createdConfigs: [],
        channels: [],
        createdChannels: 0,
        closedPeers: 0,
        closedChannels: 0,
        sentPayloads: [],
      },
      objectUrls: {
        created: 0,
        revoked: 0,
      },
      clipboard: [],
      downloads: 0,
    };

    Object.defineProperty(window, "RTCPeerConnection", { configurable: true, writable: true, value: FakePeerConnection });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          window.__appTest.clipboard.push(text);
        },
      },
    });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    URL.createObjectURL = () => {
      window.__appTest.objectUrls.created += 1;
      return `blob:test-${window.__appTest.objectUrls.created}`;
    };
    URL.revokeObjectURL = () => {
      window.__appTest.objectUrls.revoked += 1;
    };
    HTMLAnchorElement.prototype.click = function click() {
      window.__appTest.downloads += 1;
    };
  }, {
    candidateTypes: options.candidateTypes ?? ["host", "srflx", "relay"],
    dataChannelState: options.dataChannelState ?? "open",
    dataChannelFailure: options.dataChannelFailure ?? null,
  });
}

export async function openRoute(page: Page, route: RouteId) {
  await page.goto(routePath[route]);
  await page.addStyleTag({
    content: "*,*::before,*::after{transition-duration:0s!important;animation-duration:0s!important;scroll-behavior:auto!important}",
  });
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expectActiveNav(page, route);
}

export async function expectActiveNav(page: Page, route: RouteId) {
  const item = page.getByTestId(`nav-item-${route}`);
  await expect(item).toHaveAttribute("aria-current", "page");
  await expect(item).toBeVisible();
}

export async function selectFile(page: Page, name = "hello.txt") {
  await page.locator('input[type="file"]').setInputFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from("hello from tests"),
  });
}

export async function getLayoutMetrics(page: Page) {
  return page.evaluate(() => {
    function rectFor(selector: string, fallback?: string) {
      const element = document.querySelector(selector) ?? (fallback ? document.querySelector(fallback) : null);
      if (!element) throw new Error(`Missing layout element: ${selector}`);
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
      };
    }

    const activeNav = document.querySelector("nav a[aria-current='page']");
    if (!activeNav) throw new Error("Missing active nav item");
    const activeNavRect = activeNav.getBoundingClientRect();

    return {
      shell: rectFor("[data-testid='app-shell']", "main"),
      brand: rectFor("[data-testid='app-brand']"),
      header: rectFor("[data-testid='app-header']", "header"),
      nav: rectFor("[data-testid='app-nav']", "nav[aria-label]"),
      slider: rectFor("[data-testid='nav-active-indicator']", "nav span[aria-hidden='true']"),
      pageSlot: rectFor("[data-testid='page-slot']", "main > :nth-child(2)"),
      workspace: rectFor("[data-testid='transfer-page-root']"),
      statusPanel: rectFor("[data-testid='status-panel']"),
      statusSteps: rectFor("[data-testid='transfer-steps']"),
      targetPanel: rectFor("[data-testid='target-panel']"),
      uploadPanel: rectFor("[data-testid='upload-panel']"),
      fileListPanel: rectFor("[data-testid='file-list-panel']"),
      uploadDropzone: rectFor("[data-testid='file-upload-dropzone']"),
      activeNav: {
        x: activeNavRect.x,
        y: activeNavRect.y,
        width: activeNavRect.width,
        height: activeNavRect.height,
        top: activeNavRect.top,
        left: activeNavRect.left,
        right: activeNavRect.right,
        bottom: activeNavRect.bottom,
      },
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      hasVerticalScrollbar: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    };
  });
}

export function expectRectStable(
  before: Awaited<ReturnType<typeof getLayoutMetrics>>,
  after: Awaited<ReturnType<typeof getLayoutMetrics>>,
  keys: Array<
    | "shell"
    | "brand"
    | "header"
    | "nav"
    | "pageSlot"
    | "workspace"
    | "statusPanel"
    | "statusSteps"
    | "targetPanel"
    | "uploadPanel"
    | "fileListPanel"
    | "uploadDropzone"
  >,
  tolerance = 2,
) {
  for (const key of keys) {
    expect(Math.abs(after[key].x - before[key].x), `${key}.x`).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(after[key].y - before[key].y), `${key}.y`).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(after[key].width - before[key].width), `${key}.width`).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(after[key].height - before[key].height), `${key}.height`).toBeLessThanOrEqual(tolerance);
  }
}

export async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await getLayoutMetrics(page);
  expect(metrics.scrollWidth).toBe(metrics.clientWidth);
}

export async function expectSliderAligned(page: Page) {
  const metrics = await getLayoutMetrics(page);
  expect(Math.abs(metrics.slider.x - metrics.activeNav.x), "slider.x").toBeLessThanOrEqual(2);
  expect(Math.abs(metrics.slider.y - metrics.activeNav.y), "slider.y").toBeLessThanOrEqual(2);
  expect(Math.abs(metrics.slider.width - metrics.activeNav.width), "slider.width").toBeLessThanOrEqual(2);
  expect(Math.abs(metrics.slider.height - metrics.activeNav.height), "slider.height").toBeLessThanOrEqual(2);
}

export async function waitForLayoutStable(page: Page) {
  await page.waitForFunction(
    (selectors) =>
      new Promise<boolean>((resolve) => {
        let last = "";
        let stableFrames = 0;

        const read = () =>
          selectors
            .map((selector) => {
              const element = document.querySelector(selector);
              if (!element) return "missing";
              const rect = element.getBoundingClientRect();
              return [
                Math.round(rect.x * 100) / 100,
                Math.round(rect.y * 100) / 100,
                Math.round(rect.width * 100) / 100,
                Math.round(rect.height * 100) / 100,
              ].join(",");
            })
            .join("|");

        const tick = () => {
          const current = read();
          stableFrames = current === last ? stableFrames + 1 : 0;
          last = current;
          if (stableFrames >= 3) {
            resolve(true);
            return;
          }
          requestAnimationFrame(tick);
        };

        requestAnimationFrame(tick);
      }),
    [
      "[data-testid='app-header']",
      "[data-testid='app-nav']",
      "[data-testid='transfer-page-root']",
      "[data-testid='status-panel']",
      "[data-testid='target-panel']",
      "[data-testid='upload-panel']",
      "[data-testid='file-list-panel']",
    ],
  );
}

export async function expectSharedPanelsVisible(page: Page) {
  await expect(page.getByTestId("app-brand")).toBeVisible();
  await expect(page.getByTestId("app-nav")).toBeVisible();
  await expect(page.getByTestId("transfer-page-root")).toBeVisible();
  await expect(page.getByTestId("status-panel")).toBeVisible();
  await expect(page.getByTestId("target-panel")).toBeVisible();
  await expect(page.getByTestId("upload-panel")).toBeVisible();
  await expect(page.getByTestId("file-list-panel")).toBeVisible();
  await expect(page.getByTestId("file-upload-dropzone")).toBeVisible();
}

export async function expectNoLayoutOverflow(page: Page) {
  await expectNoHorizontalOverflow(page);
  const report = await page.evaluate(() => {
    const tolerance = 1;
    const panelSelectors = [
      "[data-testid='status-panel']",
      "[data-testid='target-panel']",
      "[data-testid='upload-panel']",
      "[data-testid='file-list-panel']",
    ];
    const failures: string[] = [];

    const rect = (element: Element) => element.getBoundingClientRect();
    const withinHorizontal = (child: DOMRect, parent: DOMRect) =>
      child.left >= parent.left - tolerance && child.right <= parent.right + tolerance;

    for (const selector of panelSelectors) {
      const panel = document.querySelector(selector);
      if (!panel) {
        failures.push(`missing ${selector}`);
        continue;
      }
      const panelRect = rect(panel);
      const controls = panel.querySelectorAll("button,input,textarea,[data-testid='file-upload-dropzone'],article");
      controls.forEach((control, index) => {
        const controlRect = rect(control);
        if (controlRect.width === 0 || controlRect.height === 0) return;
        if (!withinHorizontal(controlRect, panelRect)) {
          failures.push(`${selector} control ${index} horizontal overflow`);
        }
      });
    }

    const viewportWidth = document.documentElement.clientWidth;
    const workspace = document.querySelector("[data-testid='transfer-page-root']");
    if (workspace) {
      const workspaceRect = rect(workspace);
      if (workspaceRect.left < -tolerance || workspaceRect.right > viewportWidth + tolerance) {
        failures.push("workspace outside viewport");
      }
    }

    const target = document.querySelector("[data-testid='target-panel']");
    const upload = document.querySelector("[data-testid='upload-panel']");
    if (target && upload) {
      const targetRect = rect(target);
      const uploadRect = rect(upload);
      const sameRow = Math.abs(targetRect.top - uploadRect.top) <= tolerance;
      if (sameRow && targetRect.right > uploadRect.left - tolerance) {
        failures.push("target panel overlaps upload panel");
      }
    }

    const dropzone = document.querySelector("[data-testid='file-upload-dropzone']");
    if (dropzone && upload) {
      const dropzoneRect = rect(dropzone);
      const uploadRect = rect(upload);
      if (
        dropzoneRect.left < uploadRect.left - tolerance ||
        dropzoneRect.right > uploadRect.right + tolerance ||
        dropzoneRect.top < uploadRect.top - tolerance ||
        dropzoneRect.bottom > uploadRect.bottom + tolerance
      ) {
        failures.push("upload dropzone outside upload panel");
      }
    }

    return failures;
  });
  expect(report).toEqual([]);
}

export async function expectStatusPanelUsesFullLeftRail(page: Page) {
  const report = await page.evaluate(() => {
    const tolerance = 2;
    const failures: string[] = [];
    const viewportWidth = document.documentElement.clientWidth;
    if (viewportWidth < 1180) return failures;

    const panel = document.querySelector("[data-testid='status-panel']");
    const workspace = document.querySelector("[data-testid='transfer-page-root']");
    const body = panel?.querySelector(".transfer-status-panel-body");
    if (!panel || !workspace || !(body instanceof HTMLElement)) {
      return ["missing status rail elements"];
    }

    const panelRect = panel.getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();
    if (Math.abs(panelRect.bottom - workspaceRect.bottom) > tolerance) {
      failures.push("status panel does not fill left rail height");
    }

    const bodyStyle = getComputedStyle(body);
    if (bodyStyle.overflowY !== "hidden") {
      failures.push("status panel body allows default vertical scrolling");
    }
    if (body.scrollHeight > body.clientHeight + tolerance) {
      failures.push("status panel content overflows its default viewport");
    }

    if (panel.querySelector(".connection-details-expanded")) {
      failures.push("status panel should show summary view by default");
    }
    if (!panel.querySelector(".connection-details-more")) {
      failures.push("status panel is missing details view trigger");
    }

    const description = panel.querySelector(".status-panel-description");
    if (description instanceof HTMLElement) {
      const style = getComputedStyle(description);
      const lineHeight = Number.parseFloat(style.lineHeight);
      if (lineHeight > 0 && description.clientHeight > lineHeight * 2 + tolerance) {
        failures.push("status description uses more than two lines");
      }
    } else {
      failures.push("status panel is missing stable description");
    }

    return failures;
  });
  expect(report).toEqual([]);
}

export async function expectStatusPanelDetailsSwitches(page: Page) {
  const statusPanel = page.getByTestId("status-panel");
  const moreButton = statusPanel.getByRole("button", { name: "更多详情" });
  await expect(moreButton).toBeVisible();
  await moreButton.click();
  await expect(statusPanel.getByRole("heading", { name: "连接详情" })).toBeVisible();
  await expect(statusPanel.getByRole("button", { name: "返回状态" })).toBeVisible();
  await expect(statusPanel.getByRole("button", { name: "更多详情" })).toHaveCount(0);
  await statusPanel.getByRole("button", { name: "返回状态" }).click();
  await expect(statusPanel.getByRole("button", { name: "更多详情" })).toBeVisible();
}

declare global {
  interface Window {
    __appTest: {
      rtc: {
        createdConfigs: RTCConfiguration[];
        channels: Array<{
          readyState: RTCDataChannelState;
          close: () => void;
          dispatchEvent: (event: Event) => boolean;
        }>;
        createdChannels: number;
        closedPeers: number;
        closedChannels: number;
        sentPayloads: Array<
          | { kind: "text"; value: string }
          | { kind: "arrayBuffer"; byteLength: number }
        >;
      };
      objectUrls: {
        created: number;
        revoked: number;
      };
      clipboard: string[];
      downloads: number;
    };
  }
}
