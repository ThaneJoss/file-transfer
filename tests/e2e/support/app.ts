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
    errors.push(`requestfailed: ${request.method()} ${url} ${request.failure()?.errorText ?? ""}`);
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

export async function installAppMocks(page: Page, options: { candidateTypes?: Array<"host" | "srflx" | "relay"> } = {}) {
  await page.addInitScript(({ candidateTypes }) => {
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
      readyState: RTCDataChannelState = "open";

      constructor(public label: string) {
        super();
      }

      send(_data: unknown) {
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
        this.connectionState = "connected";
        this.iceConnectionState = "connected";
        this.dispatchEvent(new Event("connectionstatechange"));
        this.dispatchEvent(new Event("iceconnectionstatechange"));
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
        createdChannels: 0,
        closedPeers: 0,
        closedChannels: 0,
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
  }, { candidateTypes: options.candidateTypes ?? ["host", "srflx", "relay"] });
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
      header: rectFor("[data-testid='app-header']", "header"),
      nav: rectFor("[data-testid='app-nav']", "nav[aria-label]"),
      slider: rectFor("[data-testid='nav-active-indicator']", "nav span[aria-hidden='true']"),
      pageSlot: rectFor("[data-testid='page-slot']", "main > :nth-child(2)"),
      firstPanel: rectFor("[data-testid='panel']", "section"),
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
  keys: Array<"shell" | "header" | "nav" | "pageSlot">,
) {
  for (const key of keys) {
    expect(after[key].x, `${key}.x`).toBeCloseTo(before[key].x, 0);
    expect(after[key].y, `${key}.y`).toBeCloseTo(before[key].y, 0);
    expect(after[key].width, `${key}.width`).toBeCloseTo(before[key].width, 0);
    expect(after[key].height, `${key}.height`).toBeCloseTo(before[key].height, 0);
  }
}

export async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await getLayoutMetrics(page);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

export async function expectSliderAligned(page: Page) {
  const metrics = await getLayoutMetrics(page);
  expect(metrics.slider.x).toBeCloseTo(metrics.activeNav.x, 0);
  expect(metrics.slider.y).toBeCloseTo(metrics.activeNav.y, 0);
  expect(metrics.slider.width).toBeCloseTo(metrics.activeNav.width, 0);
  expect(metrics.slider.height).toBeCloseTo(metrics.activeNav.height, 0);
}

declare global {
  interface Window {
    __appTest: {
      rtc: {
        createdConfigs: RTCConfiguration[];
        createdChannels: number;
        closedPeers: number;
        closedChannels: number;
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
