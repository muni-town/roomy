import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { startBridge, stopBridge, getBridgeStatus } from '../../../index.js';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const { action, spaceId, channelId, discordToken, guildId } = await request.json();

    if (action === 'start') {
      if (!spaceId || !channelId || !discordToken || !guildId) {
        return json({ 
          error: 'Missing required fields: spaceId, channelId, discordToken, guildId' 
        }, { status: 400 });
      }

      const result = await startBridge(spaceId, channelId, guildId, discordToken);
      return json({ success: true, bridgeKey: result.bridgeKey });
    }

    if (action === 'stop') {
      if (!spaceId || !guildId) {
        return json({ 
          error: 'Missing required fields: spaceId, guildId' 
        }, { status: 400 });
      }

      const bridgeKey = `${spaceId}-${guildId}`;
      const result = await stopBridge(bridgeKey);
      return json({ success: result });
    }

    if (action === 'status') {
      if (!spaceId || !guildId) {
        return json({ 
          error: 'Missing required fields: spaceId, guildId' 
        }, { status: 400 });
      }

      const bridgeKey = `${spaceId}-${guildId}`;
      const status = await getBridgeStatus(bridgeKey);
      return json({ status });
    }

    return json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    console.error('Bridge API error:', error);
    return json({ 
      error: error instanceof Error ? error.message : 'Unknown error occurred' 
    }, { status: 500 });
  }
};

export const GET: RequestHandler = async ({ url }) => {
  try {
    const spaceId = url.searchParams.get('spaceId');
    const guildId = url.searchParams.get('guildId');

    if (!spaceId || !guildId) {
      return json({ 
        error: 'Missing required query parameters: spaceId, guildId' 
      }, { status: 400 });
    }

    const bridgeKey = `${spaceId}-${guildId}`;
    const status = await getBridgeStatus(bridgeKey);
    return json({ status });
  } catch (error) {
    console.error('Bridge status error:', error);
    return json({ 
      error: error instanceof Error ? error.message : 'Unknown error occurred' 
    }, { status: 500 });
  }
};