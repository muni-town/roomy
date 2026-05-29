# Roomy Appserver (a.k.a. AppView)

Mediates access to Leaf backend via ATProto XRPC interface.

## Development

Most XRPC methods are authenticated by proxying via the PDS. The appserver can be run and used locally but to be accessible to a public PDS, must be tunneled to the public web, e.g. `tailscale funnel 8080`. The tunneled endpoint becomes the DID e.g. `did:web:device.tail12345.ts.net`. These should be set in `.env`. 

`LEAF_URL` and `LEAF_UNSAFE_AUTH_TOKEN` must also be set to connect and authenticate to Leaf using an interservice token configured on Leaf.

`APPSERVER_PERSONAL_STREAM_NSID` will determine the collection to refer to for the personal stream. The appserver caches the personal stream DID with no TTL, so the `roomy.sqlite` db files need to be deleted to clear that cache. The `roomy-readstate.sqlite` db is only used to store unread count read states. It is meant as a persistent source of truth whereas the `roomy` db is derived data.

`