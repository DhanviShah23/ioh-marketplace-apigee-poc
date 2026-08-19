import type { Config } from "./config.js";

export interface CreateProductRequest {
  bundle_id: string;
  offer_version_id: number;
  tier_name: string;
  quota_limit: number;
  quota_interval: string;
  api_ids: string[];
}

export interface CreateProductResponse {
  apigee_product: { id: number; apigee_product_name: string; [key: string]: unknown };
  idempotent?: boolean;
}

export async function createApigeeProduct(config: Config, req: CreateProductRequest): Promise<CreateProductResponse> {
  const res = await fetch(`${config.governanceSvcUrl}/apigee-products`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const body = (await res.json()) as CreateProductResponse;
  if (!res.ok) {
    throw new Error(`api-governance-svc rejected product creation (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

export async function attachAppToProduct(config: Config, apigeeProductId: number, orgId: string, appId: string): Promise<unknown> {
  const res = await fetch(`${config.governanceSvcUrl}/apigee-products/${apigeeProductId}/attach-app`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ org_id: orgId, app_id: appId }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`api-governance-svc rejected app attach (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}
