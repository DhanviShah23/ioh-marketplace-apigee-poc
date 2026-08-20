import { GoogleAuth } from "google-auth-library";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let cachedAuth: GoogleAuth | undefined;

// Prefers the active `gcloud` CLI identity over ADC: on dev machines the
// mounted/well-known ADC file can belong to a different, stale account than
// whichever one is actually `gcloud auth login`-active and IAM-authorized
// on the target GCP resources. Falls back to ADC (e.g. in a real deployment
// with a service-account key and no gcloud binary present, such as Cloud Run).
export async function getAccessToken(): Promise<string> {
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
