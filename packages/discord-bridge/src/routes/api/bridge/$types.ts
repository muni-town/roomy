import type { RequestEvent } from '@sveltejs/kit';

export type RequestHandler = (event: RequestEvent) => Response | Promise<Response>;
