import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GoogleAuth } from "google-auth-library";

const execFileAsync = promisify(execFile);
let cachedAuth: GoogleAuth | undefined;

async function getAccessToken(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gcloud", ["auth", "print-access-token"]);
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // fall through to ADC
  }

  cachedAuth ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await cachedAuth.getClient();
  const token = await client.getAccessToken();
  if (!token.token) throw new Error("Failed to obtain a GCP access token from gcloud CLI or ADC");
  return token.token;
}

// Mints an ID token for `targetServiceAccount`, scoped to `audience`, via
// the IAM Credentials API. Unlike `gcloud auth print-identity-token
// --audiences=...`, this works whether the caller is a plain gcloud-CLI
// user (with roles/iam.serviceAccountTokenCreator on the target SA) or a
// deployed runtime service account — Google only mints custom-audience ID
// tokens through service-account impersonation, never directly for a
// user/external-account credential.
export async function getIdTokenForAudience(targetServiceAccount: string, audience: string): Promise<string> {
  const accessToken = await getAccessToken();
  const res = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${targetServiceAccount}:generateIdToken`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ audience, includeEmail: true }),
    }
  );
  if (!res.ok) {
    throw new Error(`Failed to mint an ID token for ${targetServiceAccount} (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}
