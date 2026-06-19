import { createAuthClient } from "better-auth/react";

import { API_BASE_URL } from "../api/client";

export const authClient = createAuthClient({
  baseURL: API_BASE_URL,
  basePath: "/api/auth",
  fetchOptions: {
    credentials: "include",
  },
});

export type AuthSession = typeof authClient.$Infer.Session;
