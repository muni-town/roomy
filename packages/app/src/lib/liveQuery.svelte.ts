import type { BindingSpec } from '@sqlite.org/sqlite-wasm';
import { backend } from './workers';
import type { LiveQueryMessage } from './setup-sqlite';

export class LiveQuery<Row extends { [key: string]: unknown }> {
	result: { rows: Row[] } | undefined = $state(undefined);
	error: string | undefined = $state(undefined);

	constructor(sql: string | (() => string), params?: () => BindingSpec) {
		$effect(() => {
			const id = crypto.randomUUID();
			const channel = new MessageChannel();
			channel.port1.onmessage = (ev) => {
				const data: LiveQueryMessage = ev.data;
				if ('error' in data) {
					this.error = data.error;
					console.warn(`Sqlite error in live query (${sql}): ${this.error}`);
				} else if ('rows' in data) {
					this.result = data as { rows: Row[] };
				}
			};
			const p = params?.();

			const s = typeof sql == 'string' ? sql : sql();

			// Obtain a lock to this query so that the shared worker can know when a live query is
			// no longer needed and it can destroy it.
			let dropLock: () => void = () => {};
			navigator.locks.request(id, async (_lock) => {
				backend.createLiveQuery(id, channel.port2, s, p);
				await new Promise((r) => (dropLock = r as any));
			});

			return () => {
				dropLock();
			};
		});
	}
}
