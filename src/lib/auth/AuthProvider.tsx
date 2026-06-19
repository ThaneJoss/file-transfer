import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { API_UNAUTHORIZED_EVENT, API_USAGE_CHANGED_EVENT, apiRequest } from "../api/client";
import { authClient } from "./client";
import type { AuthSession } from "./client";

type UsageService = "turn" | "r2" | "sfu";

type UsageRow = {
  service: UsageService;
  action: string;
  events: number;
  quantity: number;
};

type UsageCounts = Record<UsageService, number>;

type AuthContextValue = {
  session: AuthSession | null;
  isPending: boolean;
  sessionError: string;
  usage: UsageCounts;
  refreshSession: () => Promise<void>;
  refreshUsage: () => Promise<void>;
  signOut: () => Promise<void>;
};

const emptyUsage: UsageCounts = { turn: 0, r2: 0, sfu: 0 };
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
  const [usage, setUsage] = useState<UsageCounts>(emptyUsage);

  const refreshSession = useCallback(async () => {
    setInvalidated(false);
    await refetch();
  }, [refetch]);

  const refreshUsage = useCallback(async () => {
    if (!data?.user || invalidated) {
      setUsage(emptyUsage);
      return;
    }
    const response = await apiRequest<{ summary: UsageRow[] }>("/v1/usage");
    const next = { ...emptyUsage };
    for (const row of response.summary) next[row.service] += Number(row.events) || 0;
    setUsage(next);
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
