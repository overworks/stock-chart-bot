const PREFIX = "charts/";

export async function storeChart(bucket: R2Bucket, png: Uint8Array): Promise<string> {
  const key = `${PREFIX}${Date.now().toString(36)}-${crypto.randomUUID()}.png`;
  await bucket.put(key, png, { httpMetadata: { contentType: "image/png" } });
  return key;
}

export async function serveChart(bucket: R2Bucket, pathname: string): Promise<Response> {
  const key = pathname.replace(/^\//, "");
  if (!key.startsWith(PREFIX) || !key.endsWith(".png") || key.includes("..")) {
    return new Response("not found", { status: 404 });
  }
  const obj = await bucket.get(key);
  if (!obj) return new Response("not found", { status: 404 });
  return new Response(obj.body, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=86400, immutable",
      etag: obj.httpEtag,
    },
  });
}
