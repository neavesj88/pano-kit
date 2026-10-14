import { afterEach, describe, expect, it, vi } from "vitest";
import { AwsV4Signer } from "aws4fetch";
import {
  deleteVersion, listVersions, objectUrl, parseListVersions, presign, publicUrl, purgeObject, regionFromEndpoint, type BucketConfig,
} from "../src/s3";

const b2: BucketConfig = {
  endpoint: "https://s3.us-west-004.backblazeb2.com/",
  bucket: "neaves-media",
  accessKeyId: "004abc",
  secretAccessKey: "K004secret",
  region: "us-west-004",
  publicBase: "https://f004.backblazeb2.com/file/neaves-media/",
};

/* The library this depends on, against AWS's own worked example of a
   presigned URL ("Authenticating Requests: Using Query Parameters"). If this
   ever fails, every upload URL handed out is wrong. */
describe("SigV4 query signing", () => {
  it("reproduces AWS's published example signature", async () => {
    const url = new URL("https://examplebucket.s3.amazonaws.com/test.txt");
    url.searchParams.set("X-Amz-Expires", "86400");
    const signed = await new AwsV4Signer({
      method: "GET", url: url.toString(),
      accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      service: "s3", region: "us-east-1", datetime: "20130524T000000Z", signQuery: true,
    }).sign();
    expect(new URL(signed.url).searchParams.get("X-Amz-Signature"))
      .toBe("aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  });

  it("signs a short-lived PUT for one key, path-style, in the bucket's region", async () => {
    const u = new URL(await presign(b2, "PUT", "pano/ab/v1/4000.jpg", 900, "20261014T000000Z"));
    expect(u.origin + u.pathname).toBe("https://s3.us-west-004.backblazeb2.com/neaves-media/pano/ab/v1/4000.jpg");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(u.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(u.searchParams.get("X-Amz-Credential")).toBe("004abc/20261014/us-west-004/s3/aws4_request");
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("URLs and regions", () => {
  it("builds path-style object URLs and public URLs, ignoring trailing slashes", () => {
    expect(objectUrl(b2, "pano/ab/v1/2048.jpg")).toBe("https://s3.us-west-004.backblazeb2.com/neaves-media/pano/ab/v1/2048.jpg");
    expect(publicUrl(b2, "pano/ab/v1/2048.jpg")).toBe("https://f004.backblazeb2.com/file/neaves-media/pano/ab/v1/2048.jpg");
  });

  /* B2 rejects a signature made for the wrong region, and the error does not say so. */
  it("reads a B2 region from its endpoint, and nothing from anyone else's", () => {
    expect(regionFromEndpoint("https://s3.us-west-004.backblazeb2.com")).toBe("us-west-004");
    expect(regionFromEndpoint("https://s3.eu-central-003.backblazeb2.com/")).toBe("eu-central-003");
    expect(regionFromEndpoint("https://acct.r2.cloudflarestorage.com")).toBeNull();
  });
});

/* B2 keeps every version: a plain DELETE only lays a hide marker on top and the
   bytes stay billed. Freeing space means listing versions and deleting each. */
describe("versions and purging", () => {
  const page = (entries: string, tail: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>neaves-media</Name>${tail}${entries}</ListVersionsResult>`;
  const ver = (key: string, id: string, size: number, latest = true) =>
    `<Version><Key>${key}</Key><VersionId>${id}</VersionId><IsLatest>${latest}</IsLatest><LastModified>2026-10-14T01:02:03.000Z</LastModified><ETag>"x"</ETag><Size>${size}</Size></Version>`;
  const marker = (key: string, id: string) =>
    `<DeleteMarker><Key>${key}</Key><VersionId>${id}</VersionId><IsLatest>true</IsLatest><LastModified>2026-10-14T02:00:00.000Z</LastModified></DeleteMarker>`;

  afterEach(() => vi.unstubAllGlobals());

  it("reads versions and delete markers, unescaping keys, and the paging markers", () => {
    const p = parseListVersions(page(
      ver("pano/a/v1/2048.jpg", "4_z1", 1000, false) + marker("pano/a/v1/2048.jpg", "4_z2") + ver("pano/a&amp;b.jpg", "4_z3", 5),
      "<IsTruncated>true</IsTruncated><NextKeyMarker>pano/a&amp;b.jpg</NextKeyMarker><NextVersionIdMarker>4_z3</NextVersionIdMarker>",
    ));
    expect(p.truncated).toBe(true);
    expect(p.nextKeyMarker).toBe("pano/a&b.jpg");
    expect(p.nextVersionIdMarker).toBe("4_z3");
    expect(p.versions).toEqual([
      { key: "pano/a/v1/2048.jpg", versionId: "4_z1", size: 1000, lastModified: "2026-10-14T01:02:03.000Z", isLatest: false, deleteMarker: false },
      { key: "pano/a/v1/2048.jpg", versionId: "4_z2", size: 0, lastModified: "2026-10-14T02:00:00.000Z", isLatest: true, deleteMarker: true },
      { key: "pano/a&b.jpg", versionId: "4_z3", size: 5, lastModified: "2026-10-14T01:02:03.000Z", isLatest: true, deleteMarker: false },
    ]);
  });

  it("pages through a listing, falling back to the last entry when B2 sends no Next markers", async () => {
    const seen: URL[] = [];
    vi.stubGlobal("fetch", async (req: Request) => {
      const u = new URL(req.url);
      seen.push(u);
      expect(req.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=004abc\//);
      const body = u.searchParams.has("key-marker")
        ? page(ver("pano/b", "2", 20), "<IsTruncated>false</IsTruncated>")
        : page(ver("pano/a", "1", 10), "<IsTruncated>true</IsTruncated>");
      return new Response(body, { status: 200 });
    });
    const all = await listVersions(b2, "pano/");
    expect(all.map(v => v.key)).toEqual(["pano/a", "pano/b"]);
    expect(seen).toHaveLength(2);
    expect(seen[0].pathname).toBe("/neaves-media");
    expect(seen[0].searchParams.has("versions")).toBe(true);
    expect(seen[0].searchParams.get("prefix")).toBe("pano/");
    expect(seen[1].searchParams.get("key-marker")).toBe("pano/a");
    expect(seen[1].searchParams.get("version-id-marker")).toBe("1");
  });

  it("refuses to loop on a listing that never moves on", async () => {
    vi.stubGlobal("fetch", async () => new Response(page(ver("pano/a", "1", 10), "<IsTruncated>true</IsTruncated>"), { status: 200 }));
    await expect(listVersions(b2, "pano/")).rejects.toThrow(/did not move on/);
  });

  it("purges every version of exactly that key, real versions before markers, and counts the bytes", async () => {
    const deleted: string[] = [];
    vi.stubGlobal("fetch", async (req: Request) => {
      const u = new URL(req.url);
      if (req.method === "GET") {
        return new Response(page(
          marker("pano/a/thumb-1.jpg", "m1") + ver("pano/a/thumb-1.jpg", "v1", 300, false) + ver("pano/a/thumb-1.jpg.bak", "x", 9),
          "<IsTruncated>false</IsTruncated>",
        ), { status: 200 });
      }
      expect(req.method).toBe("DELETE");
      deleted.push(`${decodeURIComponent(u.pathname)}?${u.searchParams.get("versionId")}`);
      return new Response(null, { status: 204 });
    });
    expect(await purgeObject(b2, "pano/a/thumb-1.jpg")).toBe(300);
    expect(deleted).toEqual(["/neaves-media/pano/a/thumb-1.jpg?v1", "/neaves-media/pano/a/thumb-1.jpg?m1"]);
  });

  it("says which version the bucket would not delete", async () => {
    vi.stubGlobal("fetch", async () => new Response("denied", { status: 403 }));
    await expect(deleteVersion(b2, "pano/a", "v9")).rejects.toThrow(/pano\/a \(v9\): HTTP 403/);
  });
});
