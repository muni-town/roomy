import type { DownloadEvent, Update } from '@tauri-apps/plugin-updater';
import { createContext } from 'svelte';

function persistedBool(key: string, defaultValue = false) {
}

// TODO: expose this as an env flag during build,
//       for package managers handling updates externally.
const DISABLE_INTERNAL_UPDATE = false;
export const desktopUpdatesEnabled =
  "__TAURI__" in window &&
  typeof window.__TAURI__ === 'object' &&
  "updater" in window.__TAURI__ &&
  !DISABLE_INTERNAL_UPDATE;

export class Updater {
  #enableAutoupdate = $state(localStorage.getItem('enableAutoupdate') === null ? true : localStorage.getItem('enableAutoupdate') === 'true');

  #update: Update | null = $state(null)
  #size = $state(0)
  #status: 'initialized' | 'unavailable' | 'ready' | 'downloading' | 'complete' = $state(this.#enableAutoupdate === false ? 'unavailable' : 'initialized')
  #downloaded = $state(0)
  #progress = $derived((this.#downloaded / Math.max(this.#size, 1)) * 100.0)

  get enableAutoupdate() {
    if (!('__TAURI__' in window)) return false;
    return this.#enableAutoupdate;
  }
  set enableAutoupdate(val) {
    if (!('__TAURI__' in window)) return
    this.#enableAutoupdate = val;
    localStorage.setItem('enableAutoupdate', String(val));
  }

  get update() { return this.#update }
  get size() { return this.#size }
  get downloaded() { return this.#downloaded }
  get progress() { return this.#progress }
  get status() { return this.#status }


  async downloadAndInstall() {
    if (this.#status !== 'ready') return
    this.#status = 'downloading'
    await this.#update?.downloadAndInstall((event) => {
      switch (event.event) {
        case 'Started':
          console.debug(`Running update in the background. size: ${event.data.contentLength} bytes`);
          this.#size = event.data.contentLength ?? 0
          break;
        case 'Progress':
          this.#downloaded += event.data.chunkLength
          break;
        case 'Finished':
          console.debug('App Update finished');
          this.#update = null
          this.#downloaded = 0
          this.#size = 0
          this.#status = 'complete'
          break;
      }
    });
  }

  async checkUpdate() {
    if (this.#update) return this.#update
    if (!desktopUpdatesEnabled) return "disabled"

    const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check()
      if (!update) return "no updates"

      this.#update = update
      this.#status = 'ready'
      return this.#update
  }

  async tryUpdate() {
    await this.checkUpdate()
    await this.downloadAndInstall()
  }
}

export const [getUpdater, setUpdater] = createContext<Updater>()
