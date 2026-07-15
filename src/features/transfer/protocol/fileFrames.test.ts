import { describe, expect, it } from "vitest";

import { decodeControlMessage, decodeFileFrame, encodeControlMessage, encodeFileFrame } from "./fileFrames";

describe("multipath file frames", () => {
  it("round trips data and probe frames without copying the header into payload", () => {
    const data = decodeFileFrame(encodeFileFrame("data", 42, new Uint8Array([1, 2, 3])));
    expect(data).toEqual({ kind: "data", sequence: 42, payload: new Uint8Array([1, 2, 3]) });
    expect(decodeFileFrame(encodeFileFrame("probe", 9, new Uint8Array([4])))).toMatchObject({ kind: "probe", sequence: 9 });
  });

  it("rejects malformed frame headers and controls", () => {
    expect(() => decodeFileFrame(new Uint8Array(9))).toThrow("未知的数据帧");
    expect(() => decodeControlMessage('{"kind":"transfer-complete"}')).toThrow("无法识别");
  });

  it("round trips the verified completion control", () => {
    const control = {
      kind: "transfer-complete" as const,
      transferId: "transfer-id",
      route: "direct" as const,
      bytes: 5,
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    };
    expect(decodeControlMessage(encodeControlMessage(control))).toEqual(control);
  });
});
