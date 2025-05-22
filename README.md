# Roomy

Gardenable group chat made with [AT Protocol](https://atproto.com/), [Loro](https://loro.dev) and [Leaf SDK](https://github.com/muni-town/leaf).

Currently working on producing a functional proof-of-concept. See the
[Roadmap](https://github.com/orgs/muni-town/projects/8/views/4).

## Key Features

**Content fluidity:** In Roomy every communication artifact can be expanded seamlessly from chat message up to a wiki-page or even standalone channel. [Chatty message gardening](https://blog.muni.town/chatty-community-gardens/)

**Self-sovereign:** Build a self-sovereign community; you will have a local copy of your community's data at all times. And so will all your community members! [Local-first software.](https://localfirstweb.dev/)

**Peer powered:** Make communities that can, if necessary, endure purely on the shared resources of sufficiently aligned peers in a mutual-sharing network. [Peer-2-Peer software](https://blog.muni.town/roomy-deep-dive/) *(slightly outdated but gist of it remains the same)*

**Public-first; privacy-friendly:** Roomy is designed first and foremost for publicly shared, collaborative content exchange. Private conversations are carefully supported, but private spaces hosted on our network needs to go through screenings. If you don't want your private group subjected to scrutiny, we will soon support self-hosting for full privacy. [Capabilities](https://blog.muni.town/capabilities-and-identity-with-leaf/) *(also pending update)*

**Bring your own ID:** Login with Bluesky (default) (soon also Mastodon, GitHub...).  Extend your existing social profile with Roomy. [Digital Homeownership](https://blog.muni.town/digital-homeownership/)

**Bluesky-connected:** Roomy is optionally connected with the Bluesky network of 30M people. [Make a Roomy-space for any atproto Bluesky account (domain)]()

## Contributions welcome!

Take a look at [our issues](https://github.com/muni-town/roomy/issues) and let us know if there is anything you can take on that isn't already assigned.

## Local Development Requirements

📦 pnpm 10.10.0
🟢 node 22.15.0

```
pnpm install
pnpm run dev
```

Tools we use:

🔸 svelte 5
🌬️ tailwind 4


## Devlog

* [Roomy Chat - Alpha](https://blog.muni.town/roomy-chat-alpha/)
* [Roomy Deep Dive: ATProto + Automerge](https://blog.muni.town/roomy-deep-dive/)

## Design

Roomy is a spiritual sibling of [Commune](https://github.com/commune-sh). The same core concepts of 'digital gardening applied to group messaging' apply.

* [Assembling Community OS](https://blog.erlend.sh/assembling-community-os)
* [Communal Bonfires](https://blog.erlend.sh/communal-bonfires)
* [Cozy Community Software](https://blog.erlend.sh/cozy-community-software)
* [Chat is minimum-viable anything](https://blog.commune.sh/chat-is-minimum-viable-anything/)
* [Beyond Discord](https://blog.commune.sh/beyond-discord/)
* [Federated Webrings](https://blog.commune.sh/federated-webrings/)
* [Chatty Community Gardens](https://blog.muni.town/chatty-community-gardens/)
