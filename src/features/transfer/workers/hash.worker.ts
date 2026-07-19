import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

type HashRequest = { blob: Blob; chunkSize: number };
type WorkerScope = {
  onmessage: ((event: MessageEvent<HashRequest>) => void) | null;
  postMessage: (value: unknown) => void;
};

const scope = globalThis as unknown as WorkerScope;

scope.onmessage = (event) => {
  void hashBlob(event.data).catch((error) => {
    scope.postMessage({ kind: "error", message: error instanceof Error ? error.message : "后台文件校验失败。" });
  });
};

async function hashBlob({ blob, chunkSize }: HashRequest) {
  const hash = sha256.create();
  let offset = 0;
  while (offset < blob.size) {
    const chunk = new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer());
    hash.update(chunk);
    offset += chunk.byteLength;
    scope.postMessage({ kind: "progress", bytes: offset });
  }
  scope.postMessage({ kind: "complete", digest: bytesToHex(hash.digest()) });
}
