const API_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const RESERVED_WORDS = new Set(["v1", "v2", "v3", "v4", "v5", "api", "apis", "vendor", "vendors", "ioh", "admin", "internal", "index"]);

// Mirrors scripts/lib/api-id.mjs's rules (DESIGN.md §1) — reimplemented
// here rather than imported, since services/ioh-portal's Docker build
// context doesn't include the repo-root scripts/ directory.
export function validateApiId(apiId: string): string[] {
  const errors: string[] = [];
  if (apiId.length < 3 || apiId.length > 63) errors.push(`api-id must be 3-63 characters (got ${apiId.length})`);
  if (!API_ID_PATTERN.test(apiId)) errors.push("api-id must be lowercase [a-z0-9-], starting and ending with a letter or number");
  if (apiId.includes("--")) errors.push("api-id must not contain consecutive hyphens");
  const firstSegment = apiId.split("-")[0];
  if (RESERVED_WORDS.has(apiId) || RESERVED_WORDS.has(firstSegment)) errors.push(`api-id uses a reserved word ("${firstSegment}")`);
  return errors;
}
