import { apiJson, apiRequest, notifyApiUsageChanged } from "../../../lib/api/client";

export type PickupVariant = "direct" | "stun";

export async function createPickup(variant: PickupVariant, offer: string) {
  const result = await apiJson<{ code: string; expiresAt: number }>("/v1/pickups", "POST", {
    variant,
    offer,
  });
  notifyApiUsageChanged();
  return result;
}

export async function getPickup(code: string) {
  const result = await apiRequest<{
    status: "found";
    variant: PickupVariant;
    offer: string;
    expiresAt: number;
    answered: boolean;
  }>(`/v1/pickups/${encodeURIComponent(code)}`, { cache: "no-store" });
  notifyApiUsageChanged();
  return result;
}

export async function submitPickupAnswer(code: string, answer: string) {
  const result = await apiJson<{ accepted: true }>(
    `/v1/pickups/${encodeURIComponent(code)}/answer`,
    "PUT",
    { answer },
  );
  notifyApiUsageChanged();
  return result;
}

export function getPickupAnswer(code: string) {
  return apiRequest<{ answer: string | null }>(
    `/v1/pickups/${encodeURIComponent(code)}/answer`,
    { cache: "no-store" },
  );
}

export async function recordTransferUsage(
  service: PickupVariant,
  bytes: number,
  transferId: string,
) {
  const result = await apiJson<{ recorded: boolean }>("/v1/usage/transfers", "POST", {
    service,
    bytes,
    transferId,
  });
  notifyApiUsageChanged();
  return result;
}
