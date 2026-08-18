export const API_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

// DESIGN.md §1: reserved words that can never be used as (or as the start of) an api-id.
export const RESERVED_WORDS = new Set([
  "v1", "v2", "v3", "v4", "v5",
  "api", "apis", "vendor", "vendors", "ioh", "admin", "internal", "index",
]);

export function validateApiIdFormat(apiId) {
  const errors = [];

  if (apiId.length < 3 || apiId.length > 63) {
    errors.push(`api-id "${apiId}" must be 3-63 characters (got ${apiId.length})`);
  }
  if (!API_ID_PATTERN.test(apiId)) {
    errors.push(
      `api-id "${apiId}" must be lowercase [a-z0-9-], start and end with a letter/number`
    );
  }
  if (apiId.includes("--")) {
    errors.push(`api-id "${apiId}" must not contain consecutive hyphens`);
  }
  const firstSegment = apiId.split("-")[0];
  if (RESERVED_WORDS.has(apiId) || RESERVED_WORDS.has(firstSegment)) {
    errors.push(`api-id "${apiId}" uses a reserved word`);
  }

  return errors;
}

// Parses a spec path into its namespace/api-id/major-version parts.
// Matches:
//   ioh/apis/{api-id}/v{N}/openapi.yaml
//   vendor/{org}/apis/{api-id}/v{N}/openapi.yaml
export function parseSpecPath(specPath) {
  const iohMatch = specPath.match(
    /^ioh\/apis\/([^/]+)\/v(\d+)\/openapi\.ya?ml$/
  );
  if (iohMatch) {
    const [, apiId, major] = iohMatch;
    return { origin: "IOH", namespace: "ioh", vendorOrgId: null, apiId, majorVersion: Number(major) };
  }

  const vendorMatch = specPath.match(
    /^vendor\/([^/]+)\/apis\/([^/]+)\/v(\d+)\/openapi\.ya?ml$/
  );
  if (vendorMatch) {
    const [, vendorOrgId, apiId, major] = vendorMatch;
    return { origin: "VENDOR", namespace: vendorOrgId, vendorOrgId, apiId, majorVersion: Number(major) };
  }

  return null;
}

// Scans the working tree for every existing api-id folder, to support the
// uniqueness check (DESIGN.md §1.2) and index generation.
export function findAllApiIdFolders(globSync) {
  const found = [];

  for (const dir of globSync("ioh/apis/*/", { onlyDirectories: true })) {
    const apiId = dir.split("/").filter(Boolean).pop();
    found.push({ apiId, origin: "IOH", namespace: "ioh", vendorOrgId: null, path: dir.replace(/\/$/, "") });
  }

  for (const dir of globSync("vendor/*/apis/*/", { onlyDirectories: true })) {
    const parts = dir.split("/").filter(Boolean);
    const vendorOrgId = parts[1];
    const apiId = parts[3];
    found.push({ apiId, origin: "VENDOR", namespace: vendorOrgId, vendorOrgId, path: dir.replace(/\/$/, "") });
  }

  return found;
}
