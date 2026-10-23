import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/public", () => ({
  env: {
    PUBLIC_MATRIX_BRIDGE_DIDS: "did:web:bridge.roomy.space",
    PUBLIC_MATRIX_BRIDGE_URL: "http://localhost:3400",
  },
}));

vi.mock("$lib/auth.svelte", () => ({
  serviceAuthToken: vi.fn(
    async (aud: string, lxm?: string) => `token:${aud}:${lxm}`,
  ),
}));

vi.mock("$lib/client", () => ({
  queryClient: { invalidateQueries: vi.fn(async () => {}) },
}));

import { serviceAuthToken } from "$lib/auth.svelte";
import { CONFIG, MATRIX_BRIDGE_CONFIGURED } from "$lib/config";
import {
  MATRIX_ADMIN_METHODS,
  MatrixAdminError,
  matrixAdminErrorCopy,
  matrixAdminFetch,
} from "$lib/queries/matrix-bridge";
import {
  createMatrixBridge,
  deleteMatrixBridge,
  updateMatrixBridge,
} from "$lib/mutations/matrix-bridge";

/** The request parts a fetch call captured, in call order. */
type FetchCall = [input: string, init: RequestInit];

/** A fetch double that resolves every call to `body`, and records its args. */
function stubFetch(body: unknown, status = 200): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    calls.push([input, init]);
    return new Response(JSON.stringify(body), { status });
  });
  return calls;
}

describe("matrix admin client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the bridge DID and admin URL from the public env", () => {
    expect(MATRIX_BRIDGE_CONFIGURED).toBe(true);
    expect(CONFIG.matrixBridgeDids).toEqual(["did:web:bridge.roomy.space"]);
  });

  it("signs the token for the bridge DID and the called method", async () => {
    const calls = stubFetch({ bridges: [] });
    await matrixAdminFetch(
      MATRIX_ADMIN_METHODS.list,
      "/_roomy/admin/v1/bridges?spaceId=x",
    );

    expect(serviceAuthToken).toHaveBeenCalledWith(
      "did:web:bridge.roomy.space",
      "_roomy.admin.bridges.list",
    );
    const [url, init] = calls[0]!;
    expect(url).toBe("http://localhost:3400/_roomy/admin/v1/bridges?spaceId=x");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer token:did:web:bridge.roomy.space:_roomy.admin.bridges.list",
    );
  });

  it("maps 401 and 403 onto copy a person can act on", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    await expect(
      matrixAdminFetch(MATRIX_ADMIN_METHODS.list, "/x"),
    ).rejects.toThrow("The bridge rejected this session. Sign in again.");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    const err = await matrixAdminFetch(MATRIX_ADMIN_METHODS.list, "/x").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MatrixAdminError);
    expect((err as MatrixAdminError).status).toBe(403);
    expect(matrixAdminErrorCopy(err)).toBe(
      "Only space admins can manage this space's Matrix bridges.",
    );
  });

  it("maps a network failure onto copy rather than surfacing the throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const err = await matrixAdminFetch(MATRIX_ADMIN_METHODS.list, "/x").catch(
      (e: unknown) => e,
    );
    expect(matrixAdminErrorCopy(err)).toBe("Couldn't reach the Matrix bridge.");
  });

  it("creates a bridge as a POST carrying the bridge fields", async () => {
    const calls = stubFetch({ id: "b1" });
    await createMatrixBridge({
      spaceId: "did:plc:space",
      matrixId: "!room:matrix.org",
      kind: "space",
      mode: "full",
      autoBridge: true,
    });

    const [url, init] = calls[0]!;
    expect(url).toBe("http://localhost:3400/_roomy/admin/v1/bridges");
    expect(init.method).toBe("POST");
    expect(serviceAuthToken).toHaveBeenLastCalledWith(
      "did:web:bridge.roomy.space",
      "_roomy.admin.bridges.create",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      spaceId: "did:plc:space",
      matrixId: "!room:matrix.org",
      kind: "space",
      mode: "full",
      autoBridge: true,
    });
  });

  it("patches and deletes by encoded bridge id", async () => {
    const calls = stubFetch({ id: "b/1" });

    await updateMatrixBridge("b/1", { autoBridge: false });
    expect(calls[0]![0]).toBe(
      "http://localhost:3400/_roomy/admin/v1/bridges/b%2F1",
    );
    expect(calls[0]![1].method).toBe("PATCH");
    expect(serviceAuthToken).toHaveBeenLastCalledWith(
      "did:web:bridge.roomy.space",
      "_roomy.admin.bridges.patch",
    );

    stubFetch({ ok: true });
    await deleteMatrixBridge("b/1");
    expect(serviceAuthToken).toHaveBeenLastCalledWith(
      "did:web:bridge.roomy.space",
      "_roomy.admin.bridges.delete",
    );
  });
});
