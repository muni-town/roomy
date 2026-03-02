# Roomy Documentation

## Architecture

Roomy is built with Vite and Sveltekit, wrapped with Tauri for cross platform support. User accounts are based on ATProto, using the PDS as an authentication and identity layer. Other app data is synced via an event-sourcing architecture, with our 'Leaf' server providing access to event streams and materialized views. A [November 2025 blog post](https://leaflet.pub/ab35bdd7-ceda-4f7f-bc9f-0222e1e58ed6) explains the Leaf architecture in more detail.

The app splits computation across three contexts: the tab (UI thread), a Dedicated Worker which manages a SQLite instance, and `Peer`, which is designed for operating in a Shared Worker, but as of March 2026 runs on the main thread - however the interface is the same. The shared worker design is inspired by an [architecture used in Notion](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite). 

The UI thread is designed to be fairly lightweight, while a Shared Worker coordinates and manages background tasks like syncing data. Peer acts as a router to a Dedicated Worker, which runs a SQLite database and handles more intensive tasks like materialising synced events into views, which can then be consumed by the UI thread.

## Dev Environment

Create a `.env` file based on `.env.example` to get started.

We operate a dev instance of Leaf server for testing, but the monorepo root also contains a compose.yml file which can be used to spin up a complete dev environment (with the only exception being the ATProto PDS for now). It runs:
- Leaf server (stores data in `/data`)
- PLC directory with postgres (each space created has a DID, so this avoids spamming the production registry)
- A full Grafana telemetry stack. The Grafana dashboard will be available at `localhost:3000`

You can also optionally add in the handle and an app password for an ATProto testing account. When these are configured in `.env`, the app will auto-authenticate to that account. This is required to run any E2E tests that require authentication, with the rationale that app password is simpler for automated authentication.

## Authentication

As mentioned above Roomy builds on ATProto for user identity. When a user logs in, they provide their handle, and this is resolved to a DID (`did:plc` or in some cases `did:web` as supported by ATProto). The DID document contains the user's PDS URL. The user is then redirected to their PDS for authentication, and upon successful login a session token is returned to Roomy. This token is used to authenticate requests to the PDS on behalf of the user. We also authenticate to the Leaf server using ATProto Service Proxying.

## Build

We use `pnpm` as a package manager and turborepo as a build system. `pnpm turbo build-web-app-prod` builds the web app for production, running `vite build` in the roomy package, then running a shell script `build-prod.sh` to generate an OAuth client metadata manifest.

## Testing

Our current focus is on using Robot Framework for integration testing. All tests can be run with `pnpm test:robot`, or specific tests by tag with `pnpm test:robot:tag <tag> tests/robot`.

## Tracing

Grafana can be run with `docker compose up -d` in the repo root and accessed at `http://localhost:3000`

## Debugging

As long as we have a persistent database, some problems are solved by clearing it. You can click your avatar in the bottom left corner for a modal with 'Reset Local Cache'. A more serious issue may require setting your browser console REPL to the sqlite worker and running `this.deleteDBs()`.

If your problem is about having too many spaces connected or you otherwise want to clear your personal stream, you can in your main REPL run `this.backend.deleteStreamRecord()` which will trigger a new one being created for you on reload.

There are other methods exposed on the global object for debugging purposes, generally found in `workers/index.ts`.
