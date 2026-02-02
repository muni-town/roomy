# Local PDS for Development

Lightweight AT Protocol Personal Data Server (PDS) for local development and testing of the Discord bridge.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    External Docker Network: roomy-dev                       │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌─────────┐  │
│  │   PDS        │◄───│   PLC        │◄───│   Leaf       │    │   Claude │  │
│  │   :2583      │    │   :3000      │    │   :5530      │    │   Code   │  │
│  └──────┬───────┘    └──────────────┘    └──────────────┘    │   Sandbox │  │
│         │                                                 └────┬────┘  │
└─────────┼──────────────────────────────────────────────────────┼─────────┘
          │                                                      │
     Host:2583                                           Can reach
     Host:3001                                           all services
     Host:5530                                           by name!
```

## One-Time Setup

First, create the shared network on your **host machine**:

```bash
docker network create roomy-dev
```

## Starting the Stack

From your **host machine**:

```bash
# 1. Start the development services
cd /path/to/ui-fixes
docker compose up -d plc-db plc-directory leaf-server pds

# 2. Check services are healthy
curl http://localhost:3001/_health  # PLC
curl http://localhost:5530/_health   # Leaf
curl http://localhost:2583/xrpc/_health  # PDS
```

### From Inside This Sandbox (claude-code container)

The sandbox can reach services by their Docker service names:

```bash
# From inside the container
curl http://plc-directory:3000/_health
curl http://leaf-server:5530/_health
curl http://pds:2583/xrpc/_health
```

## Container Networking

Inside the Docker network, services communicate by service name:

| From | To | URL |
|------|-----|-----|
| PDS | PLC | `http://plc-directory:3000` |
| PDS | Leaf | `http://leaf-server:5530` |
| Host | PDS | `http://localhost:2583` |
| Host | PLC | `http://localhost:3001` |
| Host | Leaf | `http://localhost:5530` |

## Creating an Account

1. Generate an invite code:
```bash
docker compose exec pds sh -c '
  curl --request POST \
    --user "admin:local-dev-admin-password" \
    --header "Content-Type: application/json" \
    --data "{\"useCount\": 1}" \
    "http://localhost:2583/xrpc/com.atproto.server.createInviteCode"
'
```

2. Use bsky.app with custom PDS URL: `http://localhost:2583`

## Environment Variables

Key settings in `.env`:

- `PDS_HOSTNAME=pds` - Container hostname (internal)
- `PDS_DID_PLC_URL=http://plc-directory:3000` - Local PLC
- `PDS_BSKY_APP_VIEW_URL=http://leaf-server:5530` - Local Leaf
- `PDS_JWT_SECRET` - Secret key (dev default: fine for local)

## For Discord Bridge Tests

Update your test environment to point to local services:

```bash
export LEAF_URL=http://localhost:5530
export PLC_DIRECTORY=http://localhost:3001
export ATPROTO_BRIDGE_DID=did:web:localhost  # or your local PDS account
export ATPROTO_BRIDGE_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

## Troubleshooting

**PDS won't start:**
```bash
docker compose logs pds
# Check if PLC is ready first
docker compose logs plc-directory
```

**Can't reach PLC from PDS:**
- Ensure both services are on the same Docker network
- Check `PDS_DID_PLC_URL` uses service name: `plc-directory`, not `localhost`

**Port conflicts:**
- Edit ports in `compose.yaml` if you already have services on these ports
