import { XrpcRouter, prodAuthVerifier } from "./xrpc/index.ts";
import { getConnectionTicketHandler } from "./handlers/space.roomy.auth.getConnectionTicket.ts";

const PORT = Number(process.env.PORT ?? 8080);
const OWN_DID = process.env.APPSERVER_DID ?? "did:web:appserver.roomy.chat";
const SERVICE_ENDPOINT = process.env.APPSERVER_ORIGIN ?? "https://appserver.roomy.chat";

const DID_DOCUMENT = {
  "@context": ["https://www.w3.org/ns/did/v1"],
  id: OWN_DID,
  service: [
    {
      id: "#space_roomy_appserver",
      type: "RoomyAppserver",
      serviceEndpoint: SERVICE_ENDPOINT,
    },
  ],
};

const router = new XrpcRouter(prodAuthVerifier).procedure(
  "space.roomy.auth.getConnectionTicket",
  { handler: getConnectionTicketHandler },
);

const corsHeaders = {
  "Access-Control-Allow-Origin": process.env.CORS_ORIGIN ?? "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Atproto-Proxy",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Bun.serve({
  port: PORT,
  fetch: async (req, server) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(req.url);

    if (url.pathname === "/.well-known/did.json") {
      return new Response(JSON.stringify(DID_DOCUMENT), {
        headers: { "content-type": "application/json" },
      });
    }

    const res = await router.fetch(req, server);
    if (res) {
      for (const [k, v] of Object.entries(corsHeaders)) {
        res.headers.set(k, v);
      }
    }
    return res;
  },
  websocket: router.websocket,
});

console.log(`Appserver listening on port ${PORT} (DID: ${OWN_DID})`);
