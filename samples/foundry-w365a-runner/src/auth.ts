import type { RunnerConfig } from "./config";

/**
 * Acquire an Entra bearer token for a data-plane scope. Uses a client secret when
 * AZURE_CLIENT_ID/SECRET/TENANT are set (unattended on a Cloud PC), otherwise falls
 * back to DefaultAzureCredential (az login / managed identity / VS sign-in).
 *
 * @azure/identity is an OPTIONAL dependency, loaded lazily so simulation mode and
 * the test suite never require it to be installed.
 */
export async function getToken(scope: string, auth: RunnerConfig["auth"]): Promise<string> {
  let identity: typeof import("@azure/identity");
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    identity = require("@azure/identity");
  } catch {
    throw new Error(
      "Live mode needs @azure/identity. Install it: npm install @azure/identity (it is an optional dependency)."
    );
  }

  const credential =
    auth.tenantId && auth.clientId && auth.clientSecret
      ? new identity.ClientSecretCredential(auth.tenantId, auth.clientId, auth.clientSecret)
      : new identity.DefaultAzureCredential();

  const token = await credential.getToken(scope);
  if (!token?.token) throw new Error(`Could not obtain a token for scope ${scope}.`);
  return token.token;
}
