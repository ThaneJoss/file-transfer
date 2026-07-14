export function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

const maxEncodedCharacters = 80_000;
const maxDecodedBytes = 256_000;

export function base64UrlToBytes(value: string) {
  if (value.length > maxEncodedCharacters) throw new Error("传输协议内容过大。");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function encodeConnectionPayload(payload: unknown) {
  const json = JSON.stringify(payload);
  const compression = globalThis.CompressionStream;
  if (!compression) {
    return `J1.${bytesToBase64Url(new TextEncoder().encode(json))}`;
  }

  const source = new Response(json).body;
  if (!source) return `J1.${bytesToBase64Url(new TextEncoder().encode(json))}`;
  const stream = source.pipeThrough(new compression("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return `D1.${bytesToBase64Url(new Uint8Array(buffer))}`;
}

export async function decodeConnectionPayload(value: string, decompressionError: string) {
  const trimmed = value.trim();
  if (trimmed.length > maxEncodedCharacters) throw new Error("传输协议内容过大。");
  if (trimmed.startsWith("J1.")) {
    const bytes = base64UrlToBytes(trimmed.slice(3));
    if (bytes.byteLength > maxDecodedBytes) throw new Error("传输协议内容过大。");
    return new TextDecoder().decode(bytes);
  }

  if (trimmed.startsWith("D1.")) {
    const decompression = globalThis.DecompressionStream;
    if (!decompression) {
      throw new Error(decompressionError);
    }
    const bytes = base64UrlToBytes(trimmed.slice(3));
    const source = new Response(bytes).body;
    if (!source) throw new Error(decompressionError);
    const stream = source.pipeThrough(new decompression("gzip"));
    return readTextWithLimit(stream, maxDecodedBytes);
  }

  if (new TextEncoder().encode(trimmed).byteLength > maxDecodedBytes) {
    throw new Error("传输协议内容过大。");
  }
  return trimmed;
}

async function readTextWithLimit(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error("传输协议解压后内容过大。");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
