import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { waitForBuffer, waitForDataChannelOpen } from "./dataChannel";

type Listener = EventListenerOrEventListenerObject | null;

class ListenerTrackedTarget extends EventTarget {
  private listenerCounts = new Map<string, number>();

  listenerCount(type: string) {
    return this.listenerCounts.get(type) ?? 0;
  }

  totalListeners() {
    return [...this.listenerCounts.values()].reduce((total, count) => total + count, 0);
  }

  addEventListener(type: string, listener: Listener, options?: boolean | AddEventListenerOptions) {
    this.listenerCounts.set(type, this.listenerCount(type) + 1);
    super.addEventListener(type, listener, options);
  }

  removeEventListener(type: string, listener: Listener, options?: boolean | EventListenerOptions) {
    this.listenerCounts.set(type, Math.max(0, this.listenerCount(type) - 1));
    super.removeEventListener(type, listener, options);
  }
}

class FakeDataChannel extends ListenerTrackedTarget {
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;

  constructor(public readyState: RTCDataChannelState = "connecting") {
    super();
  }

  open() {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }

  close() {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

class FakePeerConnection extends ListenerTrackedTarget {
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";
}

const asChannel = (channel: FakeDataChannel) => channel as unknown as RTCDataChannel;
const asPeer = (peer: FakePeerConnection) => peer as unknown as RTCPeerConnection;

describe("DataChannel waits", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("times out and removes every listener", async () => {
    const channel = new FakeDataChannel();
    const peer = new FakePeerConnection();
    const result = waitForDataChannelOpen(asChannel(channel), asPeer(peer), { timeoutMs: 100 });
    const assertion = expect(result).rejects.toThrow("DataChannel 打开超时");

    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(channel.totalListeners()).toBe(0);
    expect(peer.totalListeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an open wait and removes listeners plus timer", async () => {
    const channel = new FakeDataChannel();
    const peer = new FakePeerConnection();
    const controller = new AbortController();
    const result = waitForDataChannelOpen(asChannel(channel), asPeer(peer), {
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });

    controller.abort(new DOMException("测试取消", "AbortError"));
    await assertion;
    expect(channel.totalListeners()).toBe(0);
    expect(peer.totalListeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for bufferedamountlow and restores the old threshold", async () => {
    const channel = new FakeDataChannel("open");
    channel.bufferedAmount = 20;
    channel.bufferedAmountLowThreshold = 3;
    const result = waitForBuffer(asChannel(channel), { highWaterMark: 10, lowWaterMark: 5 });

    channel.bufferedAmount = 4;
    channel.dispatchEvent(new Event("bufferedamountlow"));
    await expect(result).resolves.toBeUndefined();
    expect(channel.bufferedAmountLowThreshold).toBe(3);
    expect(channel.totalListeners()).toBe(0);
  });

  it("cancels a backpressure wait without leaking listeners", async () => {
    const channel = new FakeDataChannel("open");
    channel.bufferedAmount = 20;
    const controller = new AbortController();
    const result = waitForBuffer(asChannel(channel), {
      highWaterMark: 10,
      lowWaterMark: 5,
      signal: controller.signal,
    });
    const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });

    controller.abort();
    await assertion;
    expect(channel.totalListeners()).toBe(0);
  });
});
