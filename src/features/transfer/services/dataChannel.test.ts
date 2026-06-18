import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { waitForBuffer, waitForDataChannelOpen } from "./dataChannel";

type Listener = EventListenerOrEventListenerObject | null;

class ListenerTrackedTarget extends EventTarget {
  private listenerCounts = new Map<string, number>();

  listenerCount(type: string) {
    return this.listenerCounts.get(type) ?? 0;
  }

  totalListeners() {
    return Array.from(this.listenerCounts.values()).reduce((total, count) => total + count, 0);
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

  fail() {
    this.dispatchEvent(new Event("error"));
  }
}

class FakePeerConnection extends ListenerTrackedTarget {
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";

  failIce() {
    this.iceConnectionState = "failed";
    this.dispatchEvent(new Event("iceconnectionstatechange"));
  }
}

function asChannel(channel: FakeDataChannel) {
  return channel as unknown as RTCDataChannel;
}

function asPeer(peer: FakePeerConnection) {
  return peer as unknown as RTCPeerConnection;
}

describe("DataChannel helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately when the channel is already open", async () => {
    const channel = new FakeDataChannel("open");
    const peer = new FakePeerConnection();

    await expect(waitForDataChannelOpen(asChannel(channel), asPeer(peer), { timeoutMs: 1000 })).resolves.toBeUndefined();

    expect(channel.totalListeners()).toBe(0);
    expect(peer.totalListeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects channel close and removes listeners plus timer", async () => {
    const channel = new FakeDataChannel();
    const peer = new FakePeerConnection();
    const result = waitForDataChannelOpen(asChannel(channel), asPeer(peer), { timeoutMs: 1000 });
    const assertion = expect(result).rejects.toThrow("DataChannel 已关闭");

    expect(channel.listenerCount("open")).toBe(1);
    channel.close();

    await assertion;
    expect(channel.totalListeners()).toBe(0);
    expect(peer.totalListeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects ICE failure with state details", async () => {
    const channel = new FakeDataChannel();
    const peer = new FakePeerConnection();
    const statuses: string[] = [];
    const result = waitForDataChannelOpen(asChannel(channel), asPeer(peer), {
      timeoutMs: 1000,
      includeIceState: true,
      onStatus: (message) => statuses.push(message),
    });
    const assertion = expect(result).rejects.toThrow("ICE 连接失败：failed");

    peer.failIce();

    await assertion;
    expect(statuses.at(-1)).toContain("ice=failed");
    expect(channel.totalListeners()).toBe(0);
    expect(peer.totalListeners()).toBe(0);
  });

  it("times out without leaving event listeners active", async () => {
    const channel = new FakeDataChannel();
    const peer = new FakePeerConnection();
    const result = waitForDataChannelOpen(asChannel(channel), asPeer(peer), { timeoutMs: 1000 });
    const assertion = expect(result).rejects.toThrow("DataChannel 没有打开");

    await vi.advanceTimersByTimeAsync(1000);

    await assertion;
    expect(channel.totalListeners()).toBe(0);
    expect(peer.totalListeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for bufferedamountlow, restores threshold, and cleans listeners", async () => {
    const channel = new FakeDataChannel("open");
    channel.bufferedAmount = 20;
    channel.bufferedAmountLowThreshold = 3;
    const onWait = vi.fn();
    const result = waitForBuffer(asChannel(channel), {
      highWaterMark: 10,
      lowWaterMark: 5,
      onWait,
    });

    expect(onWait).toHaveBeenCalledTimes(1);
    expect(channel.bufferedAmountLowThreshold).toBe(5);
    channel.bufferedAmount = 4;
    channel.dispatchEvent(new Event("bufferedamountlow"));

    await expect(result).resolves.toBeUndefined();
    expect(channel.bufferedAmountLowThreshold).toBe(3);
    expect(channel.totalListeners()).toBe(0);
  });

  it("rejects send waits when the channel closes", async () => {
    const channel = new FakeDataChannel("open");
    channel.bufferedAmount = 20;
    const result = waitForBuffer(asChannel(channel), {
      highWaterMark: 10,
      lowWaterMark: 5,
    });
    const assertion = expect(result).rejects.toThrow("DataChannel 已关闭，发送已中断");

    channel.close();

    await assertion;
    expect(channel.totalListeners()).toBe(0);
  });
});
