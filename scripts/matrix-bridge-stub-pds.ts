#!/usr/bin/env bun
/**
 * The two ATProto endpoints the bridge needs, for the end-to-end stack.
 *
 * The bridge uploads Matrix media to a PDS and refers to it as
 * `atblob://<did>/<cid>`, and it needs a session before it can do that. A test
 * stack has no PDS account to log in to, so this serves `createSession` and
 * `uploadBlob` over the same shape the real ones do. It stores nothing: the
 * blob's cid is derived from its bytes, and the bytes are kept in memory so
 * `getBlob` can serve them back.
 *
 * Run as `bun scripts/matrix-bridge-stub-pds.ts [port]`.
 */

const port = Number(process.argv[2] ?? process.env.STUB_PDS_PORT ?? 9999);
const did = process.env.STUB_PDS_DID ?? "did:plc:e2ebridgepds";
const handle = process.env.STUB_PDS_HANDLE ?? "bridge.test";

const blobs = new Map<string, { bytes: Uint8Array; mimeType: string }>();

function cidOf(bytes: Uint8Array): string {
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest();
  return "b" + Buffer.from(digest).toString("hex");
}

const headers = { "content-type": "application/json" };

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/xrpc/_health") {
      return Response.json({ version: "stub" });
    }

    if (path === "/xrpc/com.atproto.server.createSession") {
      return Response.json(
        {
          did,
          handle,
          accessJwt: await signedToken("access"),
          refreshJwt: await signedToken("refresh"),
        },
        { headers },
      );
    }

    if (path === "/xrpc/com.atproto.server.getSession") {
      return Response.json({ did, handle }, { headers });
    }

    if (path === "/xrpc/com.atproto.repo.uploadBlob") {
      const bytes = new Uint8Array(await request.arrayBuffer());
      const mimeType = request.headers.get("content-type") ?? "application/octet-stream";
      if (bytes.length === 0) {
        return Response.json(
          { error: "InvalidRequest", message: "empty blob" },
          { status: 400, headers },
        );
      }
      const cid = cidOf(bytes);
      blobs.set(cid, { bytes, mimeType });
      return Response.json(
        { blob: { $type: "blob", ref: { $link: cid }, mimeType, size: bytes.length } },
        { headers },
      );
    }

    const blob = path.match(/^\/xrpc\/com\.atproto\.sync\.getBlob\/([^/]+)\/([^/]+)$/);
    if (blob) {
      const stored = blobs.get(blob[2]!);
      if (!stored) {
        return Response.json({ error: "BlobNotFound" }, { status: 404, headers });
      }
      return new Response(stored.bytes, {
        headers: { "content-type": stored.mimeType },
      });
    }

    return Response.json(
      { error: "MethodNotImplemented", message: path },
      { status: 404, headers },
    );
  },
});

/**
 * A token-shaped string. The bridge treats it as an opaque credential and sends
 * it back as a bearer from `uploadBlob`, so it only has to be non-empty and
 * stable for the run.
 */
async function signedToken(kind: string): Promise<string> {
  const payload = Buffer.from(JSON.stringify({ kind, did, iat: Date.now() })).toString(
    "base64url",
  );
  return `${payload}.stub.${kind}`;
}

console.error(`[stub-pds] listening on :${port} as ${did}`);
