import type { Config } from "./config.js";

export interface CreateProductRequest {
  bundle_id: string;
  offer_version_id: number;
  tier_name: string;
  quota_limit: number;
  quota_interval: string;
  api_ids: string[];
}

export async function createApigeeProduct(config: Config, req: CreateProductRequest): Promise<unknown> {
  const res = await fetch(`${config.governanceSvcUrl}/apigee-products`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`api-governance-svc rejected product creation (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}
