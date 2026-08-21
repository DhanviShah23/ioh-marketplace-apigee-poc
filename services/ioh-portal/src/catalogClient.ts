import type { Config } from "./config.js";
import { getIdTokenForAudience } from "./gcpAuth.js";

async function authHeaders(config: Config): Promise<Record<string, string>> {
  if (!config.catalogSvcInvokerSa) return {};
  const token = await getIdTokenForAudience(config.catalogSvcInvokerSa, config.catalogSvcUrl);
  return { Authorization: `Bearer ${token}` };
}

async function call(config: Config, path: string, init?: RequestInit) {
  const res = await fetch(`${config.catalogSvcUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(await authHeaders(config)), ...(init?.headers ?? {}) },
  });
  const body = await res.json();
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `catalog service call failed (${res.status})`);
  return body;
}

export const catalogClient = {
  listBundles: (config: Config, status?: string) => call(config, `/bundles${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  getBundle: (config: Config, bundleId: string) => call(config, `/bundles/${bundleId}`),
  createBundle: (config: Config, payload: unknown) => call(config, `/bundles`, { method: "POST", body: JSON.stringify(payload) }),
  addOfferVersion: (config: Config, bundleId: string, payload: unknown) =>
    call(config, `/bundles/${bundleId}/offer-versions`, { method: "POST", body: JSON.stringify(payload) }),
  submit: (config: Config, bundleId: string) => call(config, `/bundles/${bundleId}/submit`, { method: "POST" }),
  approve: (config: Config, bundleId: string, payload: unknown) =>
    call(config, `/bundles/${bundleId}/approve`, { method: "POST", body: JSON.stringify(payload) }),
  reject: (config: Config, bundleId: string, payload: unknown) =>
    call(config, `/bundles/${bundleId}/reject`, { method: "POST", body: JSON.stringify(payload) }),
  subscribe: (config: Config, bundleId: string, payload: unknown) =>
    call(config, `/bundles/${bundleId}/subscriptions`, { method: "POST", body: JSON.stringify(payload) }),
  syncApiAssetRef: (config: Config, apiId: string) =>
    call(config, `/api-asset-refs/sync`, { method: "POST", body: JSON.stringify({ api_id: apiId }) }),
};
