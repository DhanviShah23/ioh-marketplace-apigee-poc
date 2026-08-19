import { GoogleAuth } from "google-auth-library";
import archiver from "archiver";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "./config.js";

const execFileAsync = promisify(execFile);

const MANAGEMENT_API = "https://apigee.googleapis.com/v1";

export interface OasDoc {
  info?: { title?: string; description?: string; version?: string; ["x-ioh-api-id"]?: string };
  servers?: Array<{ url?: string }>;
  [key: string]: unknown;
}

export interface ProxyDeployResult {
  proxyName: string;
  revision: number;
  status: "DEPLOYED" | "FAILED";
}

export interface ProductCreateResult {
  apigeeProductName: string;
  status: "CREATED" | "FAILED";
}

export interface AppAttachResult {
  developerEmail: string;
  appName: string;
  consumerKey: string;
  status: "ATTACHED" | "FAILED";
}

export interface ApigeeClient {
  createAndDeployProxy(opts: {
    proxyName: string;
    basePath: string;
    targetUrl: string;
    displayName: string;
    description: string;
  }): Promise<ProxyDeployResult>;

  createProduct(opts: {
    productName: string;
    displayName: string;
    proxyNames: string[];
    quotaLimit: number;
    quotaInterval: string; // 'DAY' | 'MONTH'
    attributes: Record<string, string>;
  }): Promise<ProductCreateResult>;

  attachAppToProduct(opts: {
    developerEmail: string;
    appName: string;
    productName: string;
  }): Promise<AppAttachResult>;
}

let cachedAuth: GoogleAuth | undefined;

// Prefers the active `gcloud` CLI identity over ADC: on dev machines the
// mounted/well-known ADC file can belong to a different, stale account than
// whichever one is actually `gcloud auth login`-active and IAM-authorized
// on the target Apigee org. Falls back to ADC (e.g. in a real deployment
// with a service-account key and no gcloud binary present).
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

// Builds a minimal, real apiproxy bundle: a VerifyAPIKey + Quota PreFlow
// (Quota references the matched product's quota via Apigee flow variables,
// so a tier's quota "flows" from the API product into the proxy at runtime)
// and a passthrough target derived from the spec's servers[].url.
function buildProxyBundleXml(opts: {
  proxyName: string;
  basePath: string;
  targetUrl: string;
  displayName: string;
  description: string;
}) {
  const { proxyName, basePath, targetUrl, displayName, description } = opts;

  const rootXml = `<?xml version="1.0" encoding="UTF-8"?>
<APIProxy revision="1" name="${proxyName}">
  <DisplayName>${escapeXml(displayName)}</DisplayName>
  <Description>${escapeXml(description)}</Description>
  <BasePaths>${escapeXml(basePath)}</BasePaths>
  <ProxyEndpoints><ProxyEndpoint>default</ProxyEndpoint></ProxyEndpoints>
  <TargetEndpoints><TargetEndpoint>default</TargetEndpoint></TargetEndpoints>
</APIProxy>`;

  const proxyEndpointXml = `<?xml version="1.0" encoding="UTF-8"?>
<ProxyEndpoint name="default">
  <PreFlow name="PreFlow">
    <Request>
      <Step><Name>Verify-API-Key</Name></Step>
      <Step><Name>Quota-Check</Name></Step>
    </Request>
    <Response/>
  </PreFlow>
  <Flows/>
  <HTTPProxyConnection>
    <BasePath>${escapeXml(basePath)}</BasePath>
  </HTTPProxyConnection>
  <RouteRule name="default">
    <TargetEndpoint>default</TargetEndpoint>
  </RouteRule>
</ProxyEndpoint>`;

  const targetEndpointXml = `<?xml version="1.0" encoding="UTF-8"?>
<TargetEndpoint name="default">
  <HTTPTargetConnection>
    <URL>${escapeXml(targetUrl)}</URL>
  </HTTPTargetConnection>
</TargetEndpoint>`;

  const verifyApiKeyPolicyXml = `<?xml version="1.0" encoding="UTF-8"?>
<VerifyAPIKey name="Verify-API-Key">
  <APIKey ref="request.queryparam.apikey"/>
</VerifyAPIKey>`;

  // countRef/ref pull the matched API product's quota fields at runtime —
  // this is the "quota passed as a flow variable from the bundle" mechanism.
  const quotaPolicyXml = `<?xml version="1.0" encoding="UTF-8"?>
<Quota name="Quota-Check">
  <Allow countRef="verifyapikey.Verify-API-Key.apiproduct.developer.quota.limit">1000</Allow>
  <Interval ref="verifyapikey.Verify-API-Key.apiproduct.developer.quota.interval">1</Interval>
  <TimeUnit ref="verifyapikey.Verify-API-Key.apiproduct.developer.quota.timeunit">month</TimeUnit>
</Quota>`;

  return { rootXml, proxyEndpointXml, targetEndpointXml, verifyApiKeyPolicyXml, quotaPolicyXml };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function zipProxyBundle(proxyName: string, xml: ReturnType<typeof buildProxyBundleXml>): Promise<Buffer> {
  const archive = archiver("zip", { zlib: { level: 9 } });
  const chunks: Buffer[] = [];
  archive.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    archive.on("end", () => resolve());
    archive.on("error", reject);
  });

  archive.append(xml.rootXml, { name: `apiproxy/${proxyName}.xml` });
  archive.append(xml.proxyEndpointXml, { name: "apiproxy/proxies/default.xml" });
  archive.append(xml.targetEndpointXml, { name: "apiproxy/targets/default.xml" });
  archive.append(xml.verifyApiKeyPolicyXml, { name: "apiproxy/policies/Verify-API-Key.xml" });
  archive.append(xml.quotaPolicyXml, { name: "apiproxy/policies/Quota-Check.xml" });
  await archive.finalize();
  await done;

  return Buffer.concat(chunks);
}

export function createRealApigeeClient(config: Config): ApigeeClient {
  return {
    async createAndDeployProxy(opts) {
      const token = await getAccessToken();
      const xml = buildProxyBundleXml(opts);
      const zipBuffer = await zipProxyBundle(opts.proxyName, xml);

      const importUrl = `${MANAGEMENT_API}/organizations/${config.apigeeOrg}/apis?name=${encodeURIComponent(opts.proxyName)}&action=import`;
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(zipBuffer)], { type: "application/octet-stream" }), "bundle.zip");

      const importRes = await fetch(importUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      if (!importRes.ok) {
        const body = await importRes.text();
        throw new Error(`Apigee proxy import failed (${importRes.status}): ${body}`);
      }
      const imported = (await importRes.json()) as { revision: string };
      const revision = Number(imported.revision);

      // override=true: minor/patch releases (§2 of DESIGN.md) reuse the same
      // vN proxy name, so each new registration must replace whichever
      // revision of this proxy is currently deployed in the environment.
      const deployUrl = `${MANAGEMENT_API}/organizations/${config.apigeeOrg}/environments/${config.apigeeEnv}/apis/${encodeURIComponent(opts.proxyName)}/revisions/${revision}/deployments?override=true`;
      const deployRes = await fetch(deployUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!deployRes.ok) {
        const body = await deployRes.text();
        throw new Error(`Apigee proxy deployment failed (${deployRes.status}): ${body}`);
      }

      return { proxyName: opts.proxyName, revision, status: "DEPLOYED" };
    },

    async createProduct(opts) {
      const token = await getAccessToken();
      const url = `${MANAGEMENT_API}/organizations/${config.apigeeOrg}/apiproducts`;
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: opts.productName,
          displayName: opts.displayName,
          approvalType: "auto",
          environments: [config.apigeeEnv],
          proxies: opts.proxyNames,
          quota: String(opts.quotaLimit),
          quotaInterval: "1",
          quotaTimeUnit: opts.quotaInterval === "DAY" ? "day" : "month",
          attributes: Object.entries(opts.attributes).map(([name, value]) => ({ name, value })),
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Apigee product creation failed (${res.status}): ${body}`);
      }
      return { apigeeProductName: opts.productName, status: "CREATED" };
    },

    // Uses the real developer email / app name you registered for this
    // subscriber (commercial-catalog-svc's subscriber_app row) — created
    // manually in Apigee ahead of time. If they don't exist yet, they're
    // created under that exact identity as a safety net, but the normal
    // path is: attach to the app that's already there.
    async attachAppToProduct(opts) {
      const token = await getAccessToken();
      const developerEmail = opts.developerEmail;
      const appName = opts.appName;
      const org = config.apigeeOrg;

      const devRes = await fetch(`${MANAGEMENT_API}/organizations/${org}/developers/${encodeURIComponent(developerEmail)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (devRes.status === 404) {
        const createDevRes = await fetch(`${MANAGEMENT_API}/organizations/${org}/developers`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            email: developerEmail,
            firstName: "IOH",
            lastName: "Subscriber",
            userName: sanitizeIdentifier(developerEmail.split("@")[0]),
          }),
        });
        if (!createDevRes.ok) {
          throw new Error(`Apigee developer creation failed (${createDevRes.status}): ${await createDevRes.text()}`);
        }
      } else if (!devRes.ok) {
        throw new Error(`Apigee developer lookup failed (${devRes.status}): ${await devRes.text()}`);
      }

      const appUrl = `${MANAGEMENT_API}/organizations/${org}/developers/${encodeURIComponent(developerEmail)}/apps/${encodeURIComponent(appName)}`;
      const appRes = await fetch(appUrl, { headers: { Authorization: `Bearer ${token}` } });

      if (appRes.status === 404) {
        const createAppRes = await fetch(`${MANAGEMENT_API}/organizations/${org}/developers/${encodeURIComponent(developerEmail)}/apps`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ name: appName, apiProducts: [opts.productName], keyExpiresIn: "-1" }),
        });
        if (!createAppRes.ok) {
          throw new Error(`Apigee app creation failed (${createAppRes.status}): ${await createAppRes.text()}`);
        }
        const created = (await createAppRes.json()) as { credentials: Array<{ consumerKey: string }> };
        return { developerEmail, appName, consumerKey: created.credentials[0].consumerKey, status: "ATTACHED" };
      }

      if (!appRes.ok) {
        throw new Error(`Apigee app lookup failed (${appRes.status}): ${await appRes.text()}`);
      }

      const app = (await appRes.json()) as { credentials: Array<{ consumerKey: string; apiProducts: Array<{ apiproduct: string }> }> };
      const key = app.credentials[0];
      // Apigee omits apiProducts from the credential entirely when the app
      // has none yet (rather than returning []), e.g. a freshly-created app.
      const existingProducts = (key.apiProducts ?? []).map((p) => p.apiproduct);
      const mergedProducts = existingProducts.includes(opts.productName) ? existingProducts : [...existingProducts, opts.productName];

      const updateKeyRes = await fetch(
        `${appUrl}/keys/${encodeURIComponent(key.consumerKey)}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ apiProducts: mergedProducts }),
        }
      );
      if (!updateKeyRes.ok) {
        throw new Error(`Apigee app-key product attach failed (${updateKeyRes.status}): ${await updateKeyRes.text()}`);
      }

      return { developerEmail, appName, consumerKey: key.consumerKey, status: "ATTACHED" };
    },
  };
}

function sanitizeIdentifier(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

export function createFakeApigeeClient(): ApigeeClient {
  let revisionCounter = 1;
  return {
    async createAndDeployProxy(opts) {
      return { proxyName: opts.proxyName, revision: revisionCounter++, status: "DEPLOYED" };
    },
    async createProduct(opts) {
      return { apigeeProductName: opts.productName, status: "CREATED" };
    },
    async attachAppToProduct(opts) {
      return {
        developerEmail: opts.developerEmail,
        appName: opts.appName,
        consumerKey: "fake-consumer-key",
        status: "ATTACHED",
      };
    },
  };
}
