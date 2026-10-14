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

const client = (cfg: BucketConfig) => new AwsClient({
  accessKeyId: cfg.accessKeyId,
  secretAccessKey: cfg.secretAccessKey,
  service: "s3",
  region: cfg.region,
});

/** Delete one object the S3 way. A 404 counts as done: the goal is that it is gone.
 *  On a versioned bucket, which every B2 bucket is, this only lays a delete
 *  marker on top and the bytes stay (and are billed); use purgeObject to free them. */
export async function deleteObject(cfg: BucketConfig, key: string): Promise<void> {
  const res = await client(cfg).fetch(objectUrl(cfg, key), { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`Bucket refused to delete ${key}: HTTP ${res.status}`);
}

/** One stored version of an object, or a delete marker (B2: a hide marker) on top of one. */
export interface ObjectVersion {
  key: string;
  versionId: string;
  /** Bytes; 0 for a delete marker. */
  size: number;
  lastModified: string;
  isLatest: boolean;
  deleteMarker: boolean;
}

const unescapeXml = (t: string) =>
  t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? unescapeXml(m[1]) : null;
};

/** One page of a ListObjectVersions answer. Machine-written XML with a fixed
 *  shape, so a few patterns do; a server has no DOMParser. */
export function parseListVersions(xml: string): { versions: ObjectVersion[]; truncated: boolean; nextKeyMarker: string | null; nextVersionIdMarker: string | null } {
  const versions: ObjectVersion[] = [];
  for (const m of xml.matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g)) {
    const body = m[2];
    versions.push({
      key: tag(body, "Key") ?? "",
      versionId: tag(body, "VersionId") ?? "",
      size: Number(tag(body, "Size") ?? 0),
      lastModified: tag(body, "LastModified") ?? "",
      isLatest: tag(body, "IsLatest") === "true",
      deleteMarker: m[1] === "DeleteMarker",
    });
  }
  // Only the top level's markers: an entry's own Key never sits outside its element.
  const head = xml.replace(/<(Version|DeleteMarker)>[\s\S]*?<\/\1>/g, "");
  return {
    versions,
    truncated: tag(head, "IsTruncated") === "true",
    nextKeyMarker: tag(head, "NextKeyMarker"),
    nextVersionIdMarker: tag(head, "NextVersionIdMarker"),
  };
}

/** Every version of every object under `prefix`, delete markers included, all pages.
 *  Needs a key allowed to list (B2: listFiles). */
export async function listVersions(cfg: BucketConfig, prefix = ""): Promise<ObjectVersion[]> {
  const out: ObjectVersion[] = [];
  let keyMarker: string | null = null;
  let versionMarker: string | null = null;
  for (let page = 0; page < 10000; page++) {
    const url = new URL(`${cfg.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(cfg.bucket)}`);
    url.searchParams.set("versions", "");
    url.searchParams.set("max-keys", "1000");
    if (prefix) url.searchParams.set("prefix", prefix);
    if (keyMarker != null) url.searchParams.set("key-marker", keyMarker);
    if (versionMarker != null) url.searchParams.set("version-id-marker", versionMarker);
    const res = await client(cfg).fetch(url.toString(), { method: "GET" });
    if (!res.ok) throw new Error(`Bucket refused to list ${prefix || "the bucket"}: HTTP ${res.status}`);
    const p = parseListVersions(await res.text());
    out.push(...p.versions);
    if (!p.truncated) return out;
    // B2's documentation does not promise the Next* markers; the last entry is the same place.
    const last = p.versions[p.versions.length - 1];
    const nextKey = p.nextKeyMarker ?? last?.key ?? null;
    const nextVersion = p.nextVersionIdMarker ?? last?.versionId ?? null;
    if (nextKey == null || (nextKey === keyMarker && nextVersion === versionMarker)) {
      throw new Error("The bucket listing did not move on to a next page");
    }
    keyMarker = nextKey;
    versionMarker = nextVersion;
  }
  throw new Error("The bucket listing never ended");
}

/** Remove one version of an object for good. */
export async function deleteVersion(cfg: BucketConfig, key: string, versionId: string): Promise<void> {
  const url = new URL(objectUrl(cfg, key));
  url.searchParams.set("versionId", versionId);
  const res = await client(cfg).fetch(url.toString(), { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`Bucket refused to delete ${key} (${versionId}): HTTP ${res.status}`);
}

/** Delete an object for good: every stored version, then any delete markers,
 *  so a failure part-way never leaves an old version showing again. Resolves to
 *  the bytes freed; nothing there is not an error. */
export async function purgeObject(cfg: BucketConfig, key: string, versions?: ObjectVersion[]): Promise<number> {
  const mine = (versions ?? (await listVersions(cfg, key))).filter(v => v.key === key);
  mine.sort((a, b) => Number(a.deleteMarker) - Number(b.deleteMarker));
  let freed = 0;
  for (const v of mine) {
    await deleteVersion(cfg, key, v.versionId);
    freed += v.size;
  }
  return freed;
}
