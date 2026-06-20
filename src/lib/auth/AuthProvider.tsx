import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { API_UNAUTHORIZED_EVENT, API_USAGE_CHANGED_EVENT, apiRequest } from "../api/client";
import { authClient } from "./client";
import type { AuthSession } from "./client";

export type UsageService = "direct" | "stun" | "turn" | "sfu" | "r2" | "durable";
export type UsageUnit = "bytes" | "requests";

export type UsagePeriod = {
  start: string;
  end: string;
  timezone: string;
};

export type UsageServiceSummary = {
  unit: UsageUnit;
  usage: number;
  quota: number | null;
  bytes: number;
  quotaBytes: number | null;
};

export type UsageSnapshot = {
  period: UsagePeriod | null;
  services: Record<UsageService, UsageServiceSummary>;
  totalBytes: number;
  totalQuotaBytes: number | null;
  totals: Record<UsageUnit, number>;
  quotas: Record<UsageUnit, number | null>;
};

type UsageApiRow = {
  service: UsageService;
  unit?: UsageUnit;
  usage?: number;
  quota?: number | null;
  bytes?: number;
  quotaBytes?: number | null;
};

type UsageApiResponse = {
  period: UsagePeriod;
  summary: UsageApiRow[];
  totalBytes: number;
  totalQuotaBytes: number | null;
  totals?: Record<UsageUnit, number>;
  quotas?: Record<UsageUnit, number | null>;
};

type AuthContextValue = {
  session: AuthSession | null;
  isPending: boolean;
  sessionError: string;
  usage: UsageSnapshot;
  refreshSession: () => Promise<void>;
  refreshUsage: () => Promise<void>;
  signOut: () => Promise<void>;
};

const usageServices = ["direct", "stun", "turn", "sfu", "r2", "durable"] as const satisfies readonly UsageService[];

const emptyUsage: UsageSnapshot = {
  period: null,
  services: createEmptyUsageServices(),
  totalBytes: 0,
  totalQuotaBytes: null,
  totals: { bytes: 0, requests: 0 },
  quotas: { bytes: null, requests: null },
};

const defaultContext: AuthContextValue = {
  session: null,
  isPending: false,
  sessionError: "",
  usage: emptyUsage,
  refreshSession: async () => undefined,
  refreshUsage: async () => undefined,
  signOut: async () => undefined,
};

const AuthContext = createContext<AuthContextValue>(defaultContext);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { data, isPending, error, refetch } = authClient.useSession();
  const [invalidated, setInvalidated] = useState(false);
  const [usage, setUsage] = useState<UsageSnapshot>(emptyUsage);

  const refreshSession = useCallback(async () => {
    setInvalidated(false);
    await refetch();
  }, [refetch]);

  const refreshUsage = useCallback(async () => {
    if (!data?.user || invalidated) {
      setUsage(emptyUsage);
      return;
    }
    const response = await apiRequest<UsageApiResponse>("/v1/usage", { cache: "no-store" });
    setUsage(normalizeUsageResponse(response));
  }, [data?.user, invalidated]);

  useEffect(() => {
    const handleUnauthorized = () => {
      setInvalidated(true);
      setUsage(emptyUsage);
      void refetch();
    };
    window.addEventListener(API_UNAUTHORIZED_EVENT, handleUnauthorized);
    return () => window.removeEventListener(API_UNAUTHORIZED_EVENT, handleUnauthorized);
  }, [refetch]);

  useEffect(() => {
    const handleUsageChanged = () => void refreshUsage().catch(() => undefined);
    window.addEventListener(API_USAGE_CHANGED_EVENT, handleUsageChanged);
    return () => window.removeEventListener(API_USAGE_CHANGED_EVENT, handleUsageChanged);
  }, [refreshUsage]);

  useEffect(() => {
    if (data?.user && !invalidated) {
      void refreshUsage().catch(() => setUsage(emptyUsage));
    } else {
      setUsage(emptyUsage);
    }
  }, [data?.user, invalidated, refreshUsage]);

  const value = useMemo<AuthContextValue>(() => ({
    session: invalidated ? null : data,
    isPending,
    sessionError: invalidated ? "登录已过期，请重新登录。" : error?.message ?? "",
    usage,
    refreshSession,
    refreshUsage,
    signOut: async () => {
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message || "退出登录失败。");
      setInvalidated(false);
      setUsage(emptyUsage);
      await refetch();
    },
  }), [data, error?.message, invalidated, isPending, refetch, refreshSession, refreshUsage, usage]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

function createEmptyUsageServices(): Record<UsageService, UsageServiceSummary> {
  return {
    direct: emptyService("bytes"),
    stun: emptyService("bytes"),
    turn: emptyService("bytes"),
    sfu: emptyService("bytes"),
    r2: emptyService("bytes"),
    durable: emptyService("requests"),
  };
}

function emptyService(unit: UsageUnit): UsageServiceSummary {
  return { unit, usage: 0, quota: null, bytes: 0, quotaBytes: null };
}

function normalizeUsageResponse(response: UsageApiResponse): UsageSnapshot {
  const services = createEmptyUsageServices();
  for (const row of response.summary) {
    if (!usageServices.includes(row.service)) continue;
    const unit = row.unit ?? (row.service === "durable" ? "requests" : "bytes");
    const usage = normalizeQuantity(row.usage ?? row.bytes ?? 0);
    const quota = normalizeNullableQuantity(row.quota ?? row.quotaBytes);
    services[row.service] = {
      unit,
      usage,
      quota,
      bytes: unit === "bytes" ? usage : 0,
      quotaBytes: unit === "bytes" ? quota : null,
    };
  }

  const totalBytes = normalizeQuantity(response.totals?.bytes ?? response.totalBytes);
  const totalQuotaBytes = normalizeNullableQuantity(response.quotas?.bytes ?? response.totalQuotaBytes);

  return {
    period: response.period,
    services,
    totalBytes,
    totalQuotaBytes,
    totals: {
      bytes: totalBytes,
      requests: normalizeQuantity(response.totals?.requests ?? services.durable.usage),
    },
    quotas: {
      bytes: totalQuotaBytes,
      requests: normalizeNullableQuantity(response.quotas?.requests ?? services.durable.quota),
    },
  };
}

function normalizeQuantity(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeNullableQuantity(value: number | null | undefined) {
  if (value == null) return null;
  return normalizeQuantity(value);
}
