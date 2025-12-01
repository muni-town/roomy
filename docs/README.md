# Roomy Documentation

## Architecture

Roomy is built with Vite and Sveltekit, wrapped with Tauri for cross platform support. User accounts are based on ATProto, using the PDS as an authentication and identity layer. Other app data is synced via an event-sourcing architecture, with our 'Leaf' server providing access to event streams and materialized views. A [November 2025 blog post](https://leaflet.pub/ab35bdd7-ceda-4f7f-bc9f-0222e1e58ed6) explains the Leaf architecture in more detail.

The app splits computation across three contexts: the tab (UI thread), a Shared Worker (shared between tabs) and a Dedicated Worker (one is spawned per tab, but only one is active at a time). This design is inspired by an [architecture used in Notion](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite). The UI thread is designed to be fairly lightweight, while a Shared Worker coordinates and manages background tasks like syncing data. The Shared Worker acts as a router to a Dedicated Worker, which runs a SQLite database and handles more intensive tasks like materialising synced events into views, which can then be consumed by the UI thread. 

## Authentication

As mentioned above Roomy builds on ATProto for user identity. When a user logs in, they provide their handle, and this is resolved to a DID (`did:plc` or in some cases `did:web` as supported by ATProto). The DID document contains the user's PDS URL. The user is then redirected to their PDS for authentication, and upon successful login a session token is returned to Roomy. This token is used to authenticate requests to the PDS on behalf of the user. We also authenticate to the Leaf server using ATProto Service Proxying. 

## Build

We use `pnpm` as a package manager and turborepo as a build system. `pnpm turbo build-web-app-prod` builds the web app for production, running `vite build` in the roomy package, then running a shell script `build-prod.sh` to generate an OAuth client metadata manifest.