import { apiJson, apiRequest, notifyApiUsageChanged } from "../../../lib/api/client";

export type PickupVariant = "direct" | "stun" | "turn" | "sfu" | "r2";
export type PickupPayload = {
  status: "found";
  variant: PickupVariant;
  offer: string;
  expiresAt: number;
  answered: boolean;
};

export async function createPickup(offer: string, signal?: AbortSignal) {
  const result = await apiJson<{ code: string; expiresAt: number }>("/v1/pickups", "POST", {
    variant: "r2",
    offer,
  }, { signal });
  notifyApiUsageChanged();
  return result;
}

export async function getPickup(code: string, signal?: AbortSignal) {
  const result = await apiRequest<PickupPayload>(`/v1/pickups/${encodeURIComponent(code)}`, { cache: "no-store", signal });
  notifyApiUsageChanged();
  return result;
}
