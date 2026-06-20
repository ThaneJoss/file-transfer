import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { API_UNAUTHORIZED_EVENT, API_USAGE_CHANGED_EVENT, apiRequest } from "../api/client";
import { authClient } from "./client";
import type { AuthSession } from "./client";

export type UsageService = "turn" | "sfu" | "r2";

export type UsagePeriod = {
  start: string;
  end: string;
  timezone: string;
};

export type UsageServiceSummary = {
  bytes: number;
  quotaBytes: number | null;
};

export type UsageSnapshot = {
  period: UsagePeriod | null;
  services: Record<UsageService, UsageServiceSummary>;
  totalBytes: number;
  totalQuotaBytes: number | null;
};

type UsageApiRow = {
  service: UsageService;
  bytes: number;
  quotaBytes: number | null;
};

type UsageApiResponse = {
  period: UsagePeriod;
  summary: UsageApiRow[];
  totalBytes: number;
  totalQuotaBytes: number | null;
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

const usageServices = ["turn", "sfu", "r2"] as const satisfies readonly UsageService[];

const emptyUsage: UsageSnapshot = {
  period: null,
  services: createEmptyUsageServices(),
  totalBytes: 0,
  totalQuotaBytes: null,
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
    turn: { bytes: 0, quotaBytes: null },
    sfu: { bytes: 0, quotaBytes: null },
    r2: { bytes: 0, quotaBytes: null },
  };
}

function normalizeUsageResponse(response: UsageApiResponse): UsageSnapshot {
  const services = createEmptyUsageServices();
  for (const row of response.summary) {
    if (!usageServices.includes(row.service)) continue;
    services[row.service] = {
      bytes: normalizeBytes(row.bytes),
      quotaBytes: normalizeNullableBytes(row.quotaBytes),
    };
  }

  return {
    period: response.period,
    services,
    totalBytes: normalizeBytes(response.totalBytes),
    totalQuotaBytes: normalizeNullableBytes(response.totalQuotaBytes),
  };
}

function normalizeBytes(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeNullableBytes(value: number | null | undefined) {
  if (value == null) return null;
  return normalizeBytes(value);
}
