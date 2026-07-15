import { apiJson, notifyApiUsageChanged } from "../../../lib/api/client";
import type { TransferMethod } from "../protocol/fileProtocol";

export type VerifiedTransferUsage = {
  service: TransferMethod;
  bytes: number;
  transferId: string;
};

/**
 * Usage reporting must never turn a verified file transfer into a failed one.
 * The server deduplicates retries by user, service and transferId.
 */
export async function reportVerifiedTransferUsage(usage: VerifiedTransferUsage) {
  try {
    await apiJson<{ recorded: boolean }>("/v1/usage/transfers", "POST", usage);
    notifyApiUsageChanged();
    return true;
  } catch {
    return false;
  }
}
