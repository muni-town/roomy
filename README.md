<a id="readme-top"></a>

<!-- PROJECT SHIELDS -->
<!--
*** We're using markdown "reference style" links for readability.
*** Reference links are enclosed in brackets [ ] instead of parentheses ( ).
*** See the bottom of this document for the declaration of the reference variables
*** for contributors-url, forks-url, etc.
*** https://www.markdownguide.org/basic-syntax/#reference-style-links
-->
<div align="center">

  [![Stargazers][stars-shield]][stars-url]
  [![Contributors][contributors-shield]][contributors-url]
  [![Issues][issues-shield]][issues-url]
  [![Forks][forks-shield]][forks-url]
  [![Blue Oak Model License][license-shield]][license-url]

</div>


<br />
<div align="center">
  <!-- <a href="https://github.com/muni-town/roomy">
    <img src="images/logo.png" alt="Logo" width="80" height="80">
  </a> -->

  <h3 align="center">Roomy</h3>

  <p align="center">
    Gardenable group chat made with <a href="https://loro.dev">Loro</a> and <a href="https://github.com/muni-town/leaf">Leaf SDK</a>. Authentication with <a href="https://atproto.com/">AT Protocol</a>.
    <br />
    <a href="https://roomy.chat">Join a room</a>
    &middot;
    <a href="https://github.com/muni-town/roomy/issues/new?labels=bug&template=bug-report---.md">Report Bug</a>
    &middot;
    <a href="https://github.com/muni-town/roomy/issues/new?labels=enhancement&template=feature-request---.md">Request Feature</a>
  </p>
</div>


<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-roomy">Everything you need to know</a>
      <ul>
        <li><a href="#built-with">Built with</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#local-development">Local Development</a></li>
      </ul>
    </li>
    <li><a href="#usage">Usage</a></li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li>
      <a href="#contributing">Contributing</a>
      <ul>
        <li><a href="#how-to-contribute">How to contribute</a></li>
        <li><a href="#finding-issues">Finding issues</a></li>
        <li><a href="#development-guidelines">Development guidelines</a></li>
        <li><a href="#pull-request-process">Pull request process</a></li>
      </ul>
    </li>
    <li><a href="#license">License</a></li>
    <li><a href="#contact">Contact</a></li>
    <li><a href="#acknowledgments">Acknowledgments</a></li>
  </ol>
</details>


## About Roomy

[![Roomy.chat][product-screenshot]](https://roomy.chat)

More info about Roomy TK

<p align="right">(<a href="#readme-top">back to top</a>)</p>


### Built With

[![Svelte][Svelte]][Svelte-url]
[![Tailwind][Tailwind]][Tailwind-url]
[![Vite][Vite]][Vite-url]
[![PNPM][PNPM]][PNPM-url]
[![Node][Node]][Node-url]

<p align="right">(<a href="#readme-top">back to top</a>)</p>


<!-- GETTING STARTED -->
## Getting Started

This is a mono-repository. Everything you need to run a self-hosted version of Roomy is right here. This helps us keep the app and the sdk in sync. Most of the instructions here help with running the frontend `/packges/app/` locally.

### Prerequisites

We recommend [fnm](https://github.com/Schniz/fnm) for installing and managing Node environments, but this is optional.
* Node 22.15.0+
  ```sh
  fnm install 22
  fnm use 22
  ```
* PNPM 10.10.0+
  ```sh
  npm install -g pnpm@latest-10
  ```


### Local Development

1. Clone the repo
   ```sh
   # 'depth 1' clones the latest commit only, keeping the download small
   git clone https://github.com/muni-town/roomy.git --depth 1 
   ```
2. Install NPM packages with PNPM
   ```sh
   pnpm install
   ```
3. Run dev to start svelte-kit server
   
   You can safely ignore the svelte-kit dependencies warning on first run (they will be generated)
   ```sh
   pnpm run dev
   ```
4. Join the Roomy developer space

  Sign into the app via Bluesky, then [Join the Developer Space](https://roomy.chat/-/roomy.chat/leaf:r1mbft1jhmep7atcn3mfy7mx0tkzg71dqe4c73htk0w2v6pn9zf0)

   If you run into any issues during this process, please notify the team asap. [Discord](https://discord.gg/wfqBzKjac3) is the fastest, but commenting on [this discussion](https://github.com/muni-town/roomy/discussions/224) is a close second.

<p align="right">(<a href="#readme-top">back to top</a>)</p>


## Contributions welcome!

Take a look at [our issues](https://github.com/muni-town/roomy/issues) and let us know if there is anything you can take on that isn't already assigned.

[![Discord][discord-shield]][discord-url]

Join the conversation on Discord until we make the move to Roomy, once we've finished a number of features.


## Tips

The core of Roomy runs on the Roomy SDK. You can read the [docs here](https://muni-town.github.io/roomy/). The SDK is also included inside this repo (/packages/sdk/).


## Devlog

* [Roomy Chat - Alpha](https://blog.muni.town/roomy-chat-alpha/)
* [Roomy Deep Dive: ATProto + Automerge](https://blog.muni.town/roomy-deep-dive/)

## Design

Roomy is a spiritual sibling of [Commune](https://github.com/commune-sh). The same core concepts of 'digital gardening applied to group messaging' apply.


 ## Extended reading

* [Assembling Community OS](https://blog.erlend.sh/assembling-community-os)
* [Communal Bonfires](https://blog.erlend.sh/communal-bonfires)
* [Cozy Community Software](https://blog.erlend.sh/cozy-community-software)
* [Chat is minimum-viable anything](https://blog.commune.sh/chat-is-minimum-viable-anything/)
* [Beyond Discord](https://blog.commune.sh/beyond-discord/)
* [Federated Webrings](https://blog.commune.sh/federated-webrings/)
* [Chatty Community Gardens](https://blog.muni.town/chatty-community-gardens/)


<!-- MARKDOWN LINKS & IMAGES -->
<!-- https://www.markdownguide.org/basic-syntax/#reference-style-links -->
[contributors-shield]: https://img.shields.io/github/contributors/muni-town/roomy.svg?style=for-the-badge
[contributors-url]: https://github.com/muni-town/roomy/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/muni-town/roomy.svg?style=for-the-badge
[forks-url]: https://github.com/muni-town/roomy/network/members
[stars-shield]: https://img.shields.io/github/stars/muni-town/roomy.svg?style=for-the-badge
[stars-url]: https://github.com/muni-town/roomy/stargazers
[issues-shield]: https://img.shields.io/github/issues/muni-town/roomy.svg?style=for-the-badge
[issues-url]: https://github.com/muni-town/roomy/issues
[license-shield]: https://img.shields.io/badge/License-Blue%20Oak-3E8DCC?style=for-the-badge&logoColor=white
[license-url]: https://github.com/muni-town/roomy/blob/main/LICENSE.md
[product-screenshot]: static/product-screenshot.png

[Svelte]: https://img.shields.io/badge/Svelte%205-4A4A55?style=for-the-badge&logo=svelte&logoColor=white
[Svelte-url]: https://svelte.dev
[Vite]: https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white
[Vite-url]: https://vite.dev
[Tailwind]: https://img.shields.io/badge/tailwind%204-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white
[Tailwind-url]: https://tailwindcss.com
[PNPM]: https://img.shields.io/badge/PNPM-F69220?style=for-the-badge&logo=pnpm&logoColor=white
[PNPM-url]: https://pnpm.io
[Node]: https://img.shields.io/badge/Node-5FA04E?style=for-the-badge&logo=nodedotjs&logoColor=white
[Node-url]: https://tailwindcss.com

[discord-shield]: https://img.shields.io/badge/discord-5865F2?style=for-the-badge&logo=discord&logoColor=white
[discord-url]: https://discord.gg/wfqBzKjac3
