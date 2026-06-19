import { apiJson } from "../../../lib/api/client";

type PasskeyRegistrationContextResponse = {
  context: string;
};

export async function createPasskeyRegistrationContext(name: string) {
  const response = await apiJson<PasskeyRegistrationContextResponse>("/v1/passkey/registration-context", "POST", { name });
  if (!response.context.trim()) throw new Error("Passkey 注册上下文为空。");
  return response;
}
