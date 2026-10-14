/* pano-kit s3: signing for an S3-compatible bucket (Backblaze B2, Cloudflare R2, AWS S3).
 *
 * For a server. It signs short-lived URLs so a browser can upload straight to
 * the bucket: the app server never holds the image bytes and is not subject to
 * a proxy's request-size limit. Path-style URLs, which B2 and R2 both accept.
 *
 * Signing is aws4fetch; test/s3.test.ts checks it against AWS's own published
 * SigV4 query-signing example. Needs `aws4fetch`.
 */
import { AwsClient, AwsV4Signer } from "aws4fetch";

export interface BucketConfig {
  /** B2: https://s3.us-west-004.backblazeb2.com  R2: https://<account>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** B2: the region in the endpoint (see regionFromEndpoint). R2: "auto". */
  region: string;
  /** Where the public reads objects, e.g. https://f004.backblazeb2.com/file/<bucket> */
  publicBase: string;
}

/** B2 signs with its real region, and it is in the endpoint's hostname
 *  (s3.us-west-004.backblazeb2.com). A mismatched region fails every request
 *  with a signature error that names neither, so read it rather than ask for it. */
export function regionFromEndpoint(endpoint: string): string | null {
  const m = endpoint.match(/^https?:\/\/s3\.([a-z0-9-]+)\.backblazeb2\.com/i);
  return m ? m[1].toLowerCase() : null;
}

/** Keys should be built from safe characters; encoding is belt and braces. */
const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

export function objectUrl(cfg: BucketConfig, key: string): string {
  return `${cfg.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(cfg.bucket)}/${encodeKey(key)}`;
}

export function publicUrl(cfg: BucketConfig, key: string): string {
  return `${cfg.publicBase.replace(/\/+$/, "")}/${encodeKey(key)}`;
}

/** A URL allowing exactly one method on exactly one key, for a few minutes.
 *  `datetime` (YYYYMMDDTHHMMSSZ) is for tests. */
export async function presign(
  cfg: BucketConfig,
  method: "PUT" | "GET",
  key: string,
  expiresSeconds = 15 * 60,
  datetime?: string,
): Promise<string> {
  const url = new URL(objectUrl(cfg, key));
  url.searchParams.set("X-Amz-Expires", String(expiresSeconds));
  const signer = new AwsV4Signer({
    method,
    url: url.toString(),
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: cfg.region,
    signQuery: true,
    ...(datetime ? { datetime } : {}),
  });
  return (await signer.sign()).url.toString();
}

/** Delete one object. A 404 counts as done: the goal is that it is gone. */
export async function deleteObject(cfg: BucketConfig, key: string): Promise<void> {
  const client = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: cfg.region,
  });
  const res = await client.fetch(objectUrl(cfg, key), { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`Bucket refused to delete ${key}: HTTP ${res.status}`);
}
