import { createHash } from "node:crypto";
import { getAccessToken } from "./gcpAuth.js";

const STORAGE_JSON_API = "https://storage.googleapis.com/storage/v1";
const STORAGE_UPLOAD_API = "https://storage.googleapis.com/upload/storage/v1";

async function uploadObject(bucket: string, objectPath: string, body: Buffer, contentType: string): Promise<void> {
  const token = await getAccessToken();
  const url = `${STORAGE_UPLOAD_API}/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(objectPath)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
    body: new Uint8Array(body),
  });
  if (!res.ok) {
    throw new Error(`GCS upload failed for gs://${bucket}/${objectPath} (${res.status}): ${await res.text()}`);
  }
}

async function downloadObject(bucket: string, objectPath: string): Promise<Buffer> {
  const token = await getAccessToken();
  const url = `${STORAGE_JSON_API}/b/${bucket}/o/${encodeURIComponent(objectPath)}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`GCS download failed for gs://${bucket}/${objectPath} (${res.status}): ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export interface MirrorResult {
  gcsUri: string;
  verified: boolean;
  actualSha256: string;
}

// DESIGN.md §4's checksum verification: upload, then independently
// re-download and re-hash (not trusting GCS's own crc32c/md5) for an
// apples-to-apples comparison against the Git-computed checksum.
export async function mirrorAndVerify(
  bucket: string,
  objectPath: string,
  content: Buffer,
  expectedSha256: string,
  contentType = "application/x-yaml"
): Promise<MirrorResult> {
  await uploadObject(bucket, objectPath, content, contentType);
  const roundTripped = await downloadObject(bucket, objectPath);
  const actualSha256 = createHash("sha256").update(roundTripped).digest("hex");

  return {
    gcsUri: `gs://${bucket}/${objectPath}`,
    verified: actualSha256 === expectedSha256,
    actualSha256,
  };
}

// One immutable JSON object per version event (DESIGN.md §4's logs bucket).
// Never mutated/appended-to — each commit/version gets its own object.
export async function writeEventLog(bucket: string, objectPath: string, event: Record<string, unknown>): Promise<string> {
  await uploadObject(bucket, objectPath, Buffer.from(JSON.stringify(event, null, 2)), "application/json");
  return `gs://${bucket}/${objectPath}`;
}
