import { describe, it, expect } from "vitest";
import { AwsV4Signer } from "aws4fetch";
import { objectUrl, presign, publicUrl, regionFromEndpoint, type BucketConfig } from "../src/s3";

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
