export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "https://api.file.thanejoss.com").replace(/\/+$/, "");

export const API_UNAUTHORIZED_EVENT = "file-transfer:api-unauthorized";
export const API_USAGE_CHANGED_EVENT = "file-transfer:api-usage-changed";

type ApiErrorBody = {
  error?: unknown;
  message?: unknown;
  errorCode?: unknown;
  errorDescription?: unknown;
};

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

function apiUrl(path: string) {
  return `${API_BASE_URL}/${path.replace(/^\/+/, "")}`;
}

function errorMessage(body: unknown, status: number) {
  if (body && typeof body === "object") {
    const value = body as ApiErrorBody;
    for (const candidate of [value.errorDescription, value.error, value.message, value.errorCode]) {
      if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
  }
  return status === 401 ? "登录已过期，请重新登录。" : `API 请求失败：HTTP ${status}`;
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  if (init.body !== undefined && method !== "GET" && method !== "HEAD" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(apiUrl(path), {
    ...init,
    credentials: "include",
    headers,
  });
  const text = await response.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new Event(API_UNAUTHORIZED_EVENT));
    }
    throw new ApiError(errorMessage(body, response.status), response.status, body);
  }

  if (body && typeof body === "object") {
    const value = body as ApiErrorBody;
    if (typeof value.error === "string" && value.error.trim()) {
      throw new ApiError(value.error, response.status, body);
    }
  }
  if (/^\/v1\/(turn\/credentials|r2\/credentials|sfu\/)/.test(path)) notifyApiUsageChanged();
  return body as T;
}

export function apiJson<T>(
  path: string,
  method: "POST" | "PUT",
  body: unknown,
  init: Omit<RequestInit, "method" | "body"> = {},
) {
  return apiRequest<T>(path, { ...init, method, body: JSON.stringify(body) });
}

export function notifyApiUsageChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(API_USAGE_CHANGED_EVENT));
}
