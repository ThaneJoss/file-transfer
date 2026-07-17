import { apiJson } from "../../../lib/api/client";
import type { R2Credentials } from "./r2Signing";

export type R2TemporaryCredentials = R2Credentials & {
  objectKey: string;
  expiresAt: string;
};

export function requestR2Credentials(
  fileName: string,
  signal?: AbortSignal,
  options: { fileSizeBytes?: number; objectKey?: string } = {},
) {
  return apiJson<R2TemporaryCredentials>("/v1/r2/credentials", "POST", {
    fileName,
    ttlSeconds: 3600,
    ...(options.fileSizeBytes === undefined ? {} : { fileSizeBytes: options.fileSizeBytes }),
    ...(options.objectKey ? { objectKey: options.objectKey } : {}),
  }, { signal });
}
