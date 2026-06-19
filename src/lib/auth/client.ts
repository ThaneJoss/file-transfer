import { createAuthClient } from "better-auth/react";
import { passkeyClient } from "@better-auth/passkey/client";
import type { Session, User } from "better-auth/types";

import { API_BASE_URL } from "../api/client";

export type AuthSession = {
  session: Session;
  user: User;
};

type AuthError = {
  code?: string;
  message?: string;
  status?: number;
  statusText?: string;
};

type AuthResult<T> = Promise<
  | { data: T; error: null }
  | { data: null; error: AuthError }
>;

type PasskeyAuthClient = {
  useSession: () => {
    data: AuthSession | null;
    isPending: boolean;
    isRefetching: boolean;
    error: AuthError | null;
    refetch: () => Promise<void>;
  };
  signOut: () => AuthResult<unknown>;
  signIn: {
    passkey: () => AuthResult<AuthSession>;
  };
  passkey: {
    addPasskey: (options: { name?: string; context?: string | null }) => AuthResult<unknown>;
  };
};

export const authClient = createAuthClient({
  baseURL: API_BASE_URL,
  basePath: "/api/auth",
  plugins: [passkeyClient()],
  fetchOptions: {
    credentials: "include",
  },
}) as unknown as PasskeyAuthClient;
