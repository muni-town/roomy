import type { SqlStatement, StreamEvent, MaterializerConfig } from './backendWorker';
import { _void, str, Struct, Option } from '@zicklag/scale-ts';
import { Hash, Kinds } from './encoding';

export type EventType = ReturnType<(typeof eventCodec)['dec']>;

export const config: MaterializerConfig = {
	initSql: [
		{
			sql: 'create table if not exists spaces (id blob primary key, stream blob, name text, avatar text, description text, hidden integer not null default 0 )'
		}
	],
	materializer
};

export const eventCodec = Kinds({
	'space.roomy.joinSpace.0': Hash,
	'space.roomy.leaveSpace.0': Hash,
	'space.roomy.spaceInfo.0': Struct({
		name: Option(str),
		avatar: Option(str),
		description: Option(str)
	})
});

export function materializer(streamId: string, streamEvent: StreamEvent): SqlStatement[] {
	const statements: SqlStatement[] = [];

	try {
		const event = eventCodec.dec(streamEvent.payload);

		if (event.kind == 'space.roomy.joinSpace.0') {
			statements.push({
				sql: 'insert into spaces (id, stream) values (?, ?) on conflict do update set hidden = 0',
				params: [Hash.enc(event.data), Hash.enc(streamId)]
			});
		} else if (event.kind == 'space.roomy.leaveSpace.0') {
			// TODO: in the future we want to actually delete the data we have for a space when you
			// leave it. This is slightly delicate, though: we need to make sure that we clear the
			// event cursor for the stream after we've left it, and we need to go through and delete
			// all the data for the stream from the different SQL tables.
			//
			// For now, for simplicity, we keep the valid, materialized data that we already have
			// around, but we mark the space as hidden, so that it won't be synced anymore. If the
			// space is re-joined later, then we make it not hidden and it will pick up where it
			// left off.
			statements.push({
				sql: 'update spaces set hidden = 1 where id = ? and stream = ?',
				params: [Hash.enc(event.data), Hash.enc(streamId)]
			});
		} else if (event.kind == 'space.roomy.spaceInfo.0') {
			statements.push({
				sql: 'update spaces set name = :name, avatar = :avatar, description = :description where id = :id',
				params: {
					':id': Hash.enc(streamId),
					':name': event.data.name,
					':avatar': event.data.avatar,
					':description': event.data.description
				}
			});
		}
	} catch (e) {
		console.warn('Could not parse event, ignoring:', e);
	}

	return statements;
}
