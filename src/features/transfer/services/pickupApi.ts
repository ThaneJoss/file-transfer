import {
  ApiError,
  apiJson,
  apiRequest,
  clearPickupGuestAuth,
  hasPickupGuestAuth,
  notifyApiUsageChanged,
  setPickupGuestAuth,
} from "../../../lib/api/client";
import type { TransferMethod } from "../protocol/fileProtocol";

export type PickupVariant = TransferMethod | "multipath";
export type PickupPayload = {
  status: "found";
  variant: PickupVariant;
  offer: string;
  expiresAt: number;
  answered: boolean;
};

export type PendingPickupPayload = {
  status: "pending";
  variant: PickupVariant;
  expiresAt: number;
};

export type PickupLookupPayload = PickupPayload | PendingPickupPayload;

export type PickupWinner = {
  route: TransferMethod;
  bytes: number;
  sha256: string;
};

export type PickupStatus = {
  cancelled: boolean;
  expiresAt: number;
};

export async function createPickup(
  offer: string,
  signal?: AbortSignal,
  variant: PickupVariant = "multipath",
) {
  const result = await apiJson<{ code: string; expiresAt: number }>("/v1/pickups", "POST", {
    variant,
    offer,
  }, { signal });
  notifyApiUsageChanged();
  return result;
}

export async function reservePickup(
  signal?: AbortSignal,
  variant: PickupVariant = "multipath",
) {
  const result = await apiJson<{ code: string; expiresAt: number }>("/v1/pickups", "POST", {
    variant,
  }, { signal });
  notifyApiUsageChanged();
  return result;
}

export async function publishPickupOffer(code: string, offer: string, signal?: AbortSignal) {
  const result = await apiJson<{ accepted: true }>(
    `/v1/pickups/${encodeURIComponent(code)}/offer`,
    "PUT",
    { offer },
    { signal },
  );
  notifyApiUsageChanged();
  return result;
}

export async function getPickup(code: string, signal?: AbortSignal, waitMs = 0) {
  const waitQuery = waitMs > 0 ? `?wait=${Math.min(25_000, Math.floor(waitMs))}` : "";
  const result = await apiRequest<PickupLookupPayload>(`/v1/pickups/${encodeURIComponent(code)}${waitQuery}`, {
    cache: "no-store",
    signal,
  });
  if (result.status === "found") notifyApiUsageChanged();
  return result;
}

export async function claimPickupAsGuest(code: string, signal?: AbortSignal) {
  const result = await apiRequest<{
    token: string;
    expiresAt: number;
    pickup: PickupLookupPayload;
  }>(`/v1/pickups/${encodeURIComponent(code)}/guest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal,
  });
  setPickupGuestAuth({ code, token: result.token, expiresAt: result.expiresAt });
  return result.pickup;
}

export async function waitForPickupOffer(
  code: string,
  signal?: AbortSignal,
  options: {
    onPending?: (pickup: PendingPickupPayload) => void;
    intervalMs?: number;
    waitMs?: number;
    allowGuest?: boolean;
  } = {},
) {
  const activeSignal = signal ?? new AbortController().signal;
  let expiresAt = Number.POSITIVE_INFINITY;
  let claimedPickup: PickupLookupPayload | null = null;
  if (options.allowGuest && !hasPickupGuestAuth(code)) {
    clearPickupGuestAuth();
    claimedPickup = await claimPickupAsGuest(code, activeSignal);
  }
  while (true) {
    if (activeSignal.aborted) throw abortReason(activeSignal);
    if (Date.now() >= expiresAt) throw new Error("取件码已经过期，请重新生成。");
    const pickup = claimedPickup ?? await readCoordinationRetryable(() => getPickup(code, activeSignal, options.waitMs ?? 20_000));
    claimedPickup = null;
    if (pickup?.status === "found") return pickup;
    if (pickup?.status === "pending") {
      expiresAt = pickup.expiresAt;
      options.onPending?.(pickup);
    }
    await abortableDelay(options.intervalMs ?? 250, activeSignal);
  }
}

export async function submitPickupAnswer(code: string, answer: string, signal?: AbortSignal) {
  const result = await apiJson<{ accepted: true }>(
    `/v1/pickups/${encodeURIComponent(code)}/answer`,
    "PUT",
    { answer },
    { signal },
  );
  notifyApiUsageChanged();
  return result;
}

export async function getPickupAnswer(code: string, signal?: AbortSignal, waitMs = 0) {
  const waitQuery = waitMs > 0 ? `?wait=${Math.min(25_000, Math.floor(waitMs))}` : "";
  const result = await apiRequest<{ answer: string | null }>(
    `/v1/pickups/${encodeURIComponent(code)}/answer${waitQuery}`,
    { cache: "no-store", signal },
  );
  return result.answer;
}

export async function setPickupSelection(code: string, route: TransferMethod, signal?: AbortSignal) {
  return apiJson<{ accepted: true }>(
    `/v1/pickups/${encodeURIComponent(code)}/selection`,
    "PUT",
    { route },
    { signal },
  );
}

export async function getPickupSelection(code: string, signal?: AbortSignal, waitMs = 0) {
  const waitQuery = waitMs > 0 ? `?wait=${Math.min(25_000, Math.floor(waitMs))}` : "";
  const result = await apiRequest<{ route: unknown }>(
    `/v1/pickups/${encodeURIComponent(code)}/selection${waitQuery}`,
    { cache: "no-store", signal },
  );
  if (!isTransferMethod(result.route)) throw new Error("取件线路响应格式不正确。");
  return { route: result.route };
}

export async function setPickupWinner(code: string, winner: PickupWinner, signal?: AbortSignal) {
  return apiJson<{ accepted: true }>(
    `/v1/pickups/${encodeURIComponent(code)}/winner`,
    "PUT",
    winner,
    { signal },
  );
}

export async function getPickupWinner(code: string, signal?: AbortSignal, waitMs = 0) {
  const waitQuery = waitMs > 0 ? `?wait=${Math.min(25_000, Math.floor(waitMs))}` : "";
  const result = await apiRequest<Partial<PickupWinner>>(
    `/v1/pickups/${encodeURIComponent(code)}/winner${waitQuery}`,
    { cache: "no-store", signal },
  );
  if (
    !isTransferMethod(result.route) ||
    !Number.isSafeInteger(result.bytes) || (result.bytes as number) < 0 ||
    typeof result.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(result.sha256)
  ) throw new Error("取件胜者响应格式不正确。");
  return { route: result.route, bytes: result.bytes as number, sha256: result.sha256.toLowerCase() };
}

export async function cancelPickup(code: string, signal?: AbortSignal) {
  return apiJson<{ cancelled: true }>(
    `/v1/pickups/${encodeURIComponent(code)}/cancel`,
    "PUT",
    {},
    { signal },
  );
}

export async function getPickupStatus(code: string, signal?: AbortSignal, waitMs = 0): Promise<PickupStatus> {
  const waitQuery = waitMs > 0 ? `?wait=${Math.min(25_000, Math.floor(waitMs))}` : "";
  const result = await apiRequest<Partial<PickupStatus>>(
    `/v1/pickups/${encodeURIComponent(code)}/status${waitQuery}`,
    { cache: "no-store", signal },
  );
  if (typeof result.cancelled !== "boolean" || !Number.isSafeInteger(result.expiresAt) || (result.expiresAt as number) <= 0) {
    throw new Error("取件状态响应格式不正确。");
  }
  return { cancelled: result.cancelled, expiresAt: result.expiresAt as number };
}

export async function pollPickupAnswer(code: string, signal: AbortSignal, expiresAt?: number) {
  return pollPending(() => getPickupAnswer(code, signal, 20_000), signal, expiresAt);
}

export async function pollPickupSelection(code: string, signal: AbortSignal, expiresAt?: number) {
  return pollPending(() => pending404(() => getPickupSelection(code, signal, 20_000)), signal, expiresAt);
}

export async function pollPickupWinner(code: string, signal: AbortSignal, expiresAt?: number) {
  return pollPending(() => pending404(() => getPickupWinner(code, signal, 20_000)), signal, expiresAt);
}

export async function watchPickupSelections(
  code: string,
  signal: AbortSignal,
  expiresAt: number,
  onSelection: (selection: { route: TransferMethod }) => void | Promise<void>,
): Promise<never> {
  let previous: TransferMethod | null = null;
  while (true) {
    if (signal.aborted) throw abortReason(signal);
    if (Date.now() >= expiresAt) throw new Error("取件码已经过期，请重新生成。");
    const selection = await readCoordinationRetryable(() => pending404(() => getPickupSelection(code, signal, 20_000)));
    if (selection && selection.route !== previous) {
      previous = selection.route;
      await onSelection(selection);
    }
    await abortableDelay(100, signal);
  }
}

export async function monitorPickupCancellation(
  code: string,
  signal: AbortSignal,
  expiresAt: number,
): Promise<never> {
  while (true) {
    if (signal.aborted) throw abortReason(signal);
    if (Date.now() >= expiresAt) throw new Error("取件码已经过期，请重新生成。");
    const status = await readCoordinationRetryable(() => getPickupStatus(code, signal, 20_000));
    if (status?.cancelled) throw new Error("另一端已取消传输。");
    await abortableDelay(100, signal);
  }
}

async function pollPending<T>(
  read: () => Promise<T | null>,
  signal: AbortSignal,
  expiresAt = Number.POSITIVE_INFINITY,
  intervalMs = 100,
): Promise<T> {
  while (true) {
    if (signal.aborted) throw abortReason(signal);
    if (Date.now() >= expiresAt) throw new Error("取件码已经过期，请重新生成。");
    const value = await readCoordinationRetryable(read);
    if (value !== null) return value;
    await abortableDelay(intervalMs, signal);
  }
}

async function readCoordination<T>(read: () => Promise<T>) {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ApiError && error.status === 410) {
      throw new Error("另一端已取消传输。", { cause: error });
    }
    throw error;
  }
}

async function readCoordinationRetryable<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await readCoordination(read);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 408 || error.status === 429 || error.status >= 500)) return null;
    if (error instanceof TypeError) return null;
    throw error;
  }
}

async function pending404<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    const body = error.body && typeof error.body === "object" ? error.body as { error?: unknown } : null;
    const message = typeof body?.error === "string" ? body.error.toLowerCase() : "";
    if (message.includes("not found") || message.includes("expired")) throw error;
    return null;
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timeout = window.setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener("abort", cancelled);
      resolve();
    }
    function cancelled() {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", cancelled);
      reject(abortReason(signal));
    }
    signal.addEventListener("abort", cancelled, { once: true });
  });
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException("操作已取消。", "AbortError");
}

function isTransferMethod(value: unknown): value is TransferMethod {
  return value === "direct" || value === "stun" || value === "turn" || value === "sfu" || value === "r2";
}
