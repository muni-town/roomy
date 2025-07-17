import { Client, Events, GatewayIntentBits, TextChannel } from "discord.js";
import { Dispatcher } from "undici";

export async function setupDiscordClient(token: string, envHttpProxyAgent: Dispatcher): Promise<Client> {
  const client = new Client({
    rest: {
      agent: envHttpProxyAgent,
    },
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ]
  });
  
  await client.login(token);
  
  // Wait for client to be ready
  await new Promise<void>((resolve) => {
    client.once('ready', () => {
      console.log(`Discord client logged in as ${client.user?.tag}`);
      resolve();
    });
  });

  return client;
}

export async function findOrCreateWebhook(channel: TextChannel) {
  try {
    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find(wh => wh.name === 'Roomy Bridge');
    
    if (!webhook) {
      webhook = await channel.createWebhook({
        name: 'Roomy Bridge',
        reason: 'Bridge messages from Roomy to Discord',
      });
    }
    
    return webhook;
  } catch (error) {
    console.error('Error creating webhook:', error);
    throw new Error('Failed to create webhook for message customization');
  }
}

export async function sendMessageToDiscord(client: Client, channel: TextChannel, message: {
  username: string,
  content: string,
  avatarUrl: string
}) {
  let webhook = await findOrCreateWebhook(channel);

  await webhook.send({
    content: message.content,
    username: message.username,
    avatarURL: message.avatarUrl || undefined
  });
}

export type DiscordMessage = {
  messageId: string;
  channelName: string;
  guildId: string;
  content: string;
  author: {
    username: string;
    avatarUrl: string;
  }
}


export async function startListeningToDiscord(
  client: Client,
  onMessage: (message: {}) => void
) {
  client.on(Events.MessageCreate, async (discordMessage) => {
    if (discordMessage.author.bot) return;

    const channel = discordMessage.channel as TextChannel;

    onMessage({
      messageId: discordMessage.id,
      channelName: channel.name,
      guildId: discordMessage.guildId,
      content: discordMessage.content,
      author: {
        username: discordMessage.author.username,
        avatarUrl: discordMessage.author.displayAvatarURL(),
      }
    })
  });
}

export async function getChannels(client: Client, guildId: string) {
  const guild = await client.guilds.fetch(guildId);
  if(!guild) return;

  const channels = await guild.channels.fetch();
  const textChannels = channels.filter(channel => 
    channel?.type === 0
  );

  return textChannels;
}