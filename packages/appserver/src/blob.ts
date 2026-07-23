/**
 * Blob proxy — resolves an `atblob://<did>/<cid>` to raw bytes from the
 * blob owner's PDS via `com.atproto.sync.getBlob`.
 *
 * `cdn.bsky.app/img/…` only serves images. For video and other non-image
 * blobs the browser needs the raw bytes with the correct MIME type, which
 * only the PDS can provide. The appserver resolves `did` → PDS endpoint
 * (PLC lookup, cached) and streams the response back with range support so
 * `<video>` elements can seek.
 *
 * The endpoint is **unauthenticated**: ATProto blobs referenced in public
 * records are public, and the CID is content-addressed so knowing it grants
 * no access that the record itself doesn't already imply.
 */

import { resolvePdsEndpoint } from "./identity.ts";

/**
 * Proxy `com.atproto.sync.getBlob` from the blob owner's PDS.
 *
 * Returns a `Response` ready to send to the client. Forwards `Range`
 * headers for video seeking and sets immutable cache headers (blobs are
 * content-addressed by CID).
 */
export async function proxyBlob(
  did: string,
  cid: string,
  req: Request,
): Promise<Response> {
  let pdsEndpoint: string;
  try {
    pdsEndpoint = await resolvePdsEndpoint(did);
  } catch (err) {
    return Response.json(
      {
        error: "DidResolutionFailed",
        message: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 502 },
    );
  }

  const blobUrl = `${pdsEndpoint}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`;

  // Forward Range header so video elements can seek.
  const upstreamHeaders: Record<string, string> = {};
  const range = req.headers.get("range");
  if (range) upstreamHeaders["range"] = range;

  let upstream: Response;
  try {
    upstream = await fetch(blobUrl, { headers: upstreamHeaders });
  } catch {
    return Response.json(
      { error: "PdsUnreachable", message: `Could not reach PDS at ${pdsEndpoint}` },
      { status: 502 },
    );
  }

  if (!upstream.ok || upstream.body === null) {
    return Response.json(
      {
        error: "BlobFetchFailed",
        message: `PDS returned ${upstream.status} for ${did}/${cid}`,
      },
      { status: upstream.status === 404 ? 404 : 502 },
    );
  }

  // Content-addressed by CID → immutable.
  const respHeaders = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) respHeaders.set("content-type", ct);
  const cl = upstream.headers.get("content-length");
  if (cl) respHeaders.set("content-length", cl);
  const cr = upstream.headers.get("content-range");
  if (cr) respHeaders.set("content-range", cr);
  respHeaders.set("cache-control", "public, max-age=31536000, immutable");
  respHeaders.set("accept-ranges", "bytes");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}
