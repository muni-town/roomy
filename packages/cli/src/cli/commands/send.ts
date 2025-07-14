import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { OAuthSessionManager } from '../../auth/oauth-session-manager.js';
import { RoomyJazzClient } from '../../jazz/client.js';
import type { MessageOptions } from '../../types/index.js';
import { isSupportedImageFormat } from '../../bluesky/upload.js';
import { getCredentials } from '../../auth/utils.js';

export const sendCommand = new Command('send')
  .description('Send a message to a Roomy channel')
  .option('-s, --space <space>', 'Space name or ID')
  .option('-c, --channel <channel>', 'Channel name or ID')
  .option('-m, --message <message>', 'Message content')
  .option('-t, --thread <thread>', 'Thread ID (optional)')
  .option('-r, --reply <messageId>', 'Reply to message ID (optional)')
  .option('-w, --worker <handle>', 'Use Jazz Server Worker')
  .option('-i, --image <path>', 'Path to image file to upload')
  .option(
    '--max-size <size>',
    'Maximum image size in pixels (default: 2048)',
    '2048'
  )
  .option('--quality <quality>', 'Image quality (1-100, default: 85)', '85')
  .action(async (options) => {
    try {
      const credentials = await getCredentials(options);
      const jazzClient = new RoomyJazzClient();
      await jazzClient.initialize(credentials);

      // Get or select space
      let spaceId = 'space' in options ? options.space : null;
      const selectedSpaceId = await selectSpace(jazzClient, spaceId);
      if (!selectedSpaceId) {
        throw new Error(`❌ Space "${spaceId}" not found.`);
      }

      let channelId = 'channel' in options ? options.channel : null;
      const selectedChannelId = await selectChannel(
        jazzClient,
        selectedSpaceId,
        channelId
      );
      if (!selectedChannelId) {
        throw new Error(`❌ Channel "${channelId}" not found.`);
      }

      const messageContent = await getMessageContent(options.message);
      const message = {
        content: messageContent,
        threadId: options.thread,
        replyTo: options.reply,
      };

      const image = {
        path: options.image,
        maxSize: options.maxSize,
        quality: options.quality,
      };

      await sendMessage(
        jazzClient,
        selectedSpaceId,
        selectedChannelId,
        message,
        image
      );
    } catch (error) {
      console.error(
        chalk.red(
          `❌ Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
      );
      process.exit(1);
    }
  });

async function selectSpace(
  jazzClient: RoomyJazzClient,
  spaceId?: string
): Promise<string> {
  if (!spaceId) {
    const spaces = await jazzClient.loadSpaces();

    if (!spaces) {
      throw new Error(
        '❌ No spaces found. Join a space first on https://roomy.space'
      );
    }

    if (spaces.length === 0) {
      throw new Error(
        '❌ No spaces found. Join a space first on https://roomy.space'
      );
    }

    const { chosenSpace: chosenSpaceId }: { chosenSpace: string } =
      await inquirer.prompt([
        {
          type: 'list',
          name: 'chosenSpace',
          message: 'Select a space:',
          choices: spaces?.map((space) => ({
            name: `${space?.name} (${space?.members?.length || 0} members)`,
            value: space?.id,
          })),
        },
      ]);
    return chosenSpaceId;
  } else {
    // Find space by name or ID
    const spaces = await jazzClient.loadSpaces();
    return (
      spaces?.find((s) => s?.id === spaceId || s?.name === spaceId)?.id ?? ''
    );
  }
}

async function selectChannel(
  jazzClient: RoomyJazzClient,
  spaceId: string,
  channelId?: string
) {
  // Get or select channel
  let selectedChannel;
  const channels = await jazzClient.loadChannels(spaceId);
  if (!channelId) {
    if (!channels || channels.length === 0) {
      throw new Error('❌ No channels found in this space.');
    }

    const { chosenChannel } = await inquirer.prompt([
      {
        type: 'list',
        name: 'chosenChannel',
        message: 'Select a channel:',
        choices: channels.map((channel) => ({
          name: `#${channel.name}`,
          value: channel,
        })),
      },
    ]);
    selectedChannel = chosenChannel;
    return selectedChannel.id;
  } else {
    // Find channel by name or ID
    return channels.find((c) => c.id === channelId || c.name === channelId);
  }
}

async function getMessageContent(
  messageContent?: string,
  imageEmbed?: boolean
) {
  // // Get message content
  if (!messageContent) {
    const { messageContent: content } = await inquirer.prompt([
      {
        type: 'input',
        name: 'messageContent',
        message: 'Enter your message:',
        validate: (input: string) => {
          if (!input.trim() && !imageEmbed)
            return 'Message cannot be empty unless uploading an image';
          return true;
        },
      },
    ]);
    return content;
  }
  return messageContent;
}

async function sendMessage(
  jazzClient: RoomyJazzClient,
  space: string,
  channel: string,
  message: {
    content: string;
    threadId?: string;
    replyTo?: string;
  },
  image: {
    path: string;
    maxSize: string;
    quality: string;
  }
) {
  // Handle image upload if specified
  let imageEmbed: { type: 'imageUrl'; url: string } | null = null;
  if (image.path) {
    if (!isSupportedImageFormat(image.path)) {
      throw new Error(
        '❌ Unsupported image format. Supported formats: jpg, jpeg, png, gif, webp, bmp'
      );
    }

    try {
      // Get the Bluesky agent from the session manager
      const sessionManager = new OAuthSessionManager();
      const agent = await sessionManager.getAgent();

      const uploadResult = await jazzClient.uploadMedia(agent, image.path, {
        maxSize: parseInt(image.maxSize),
        quality: parseInt(image.quality),
      });

      imageEmbed = {
        type: 'imageUrl',
        url: uploadResult.url,
      };

      console.log(
        chalk.green(
          `✅ Image uploaded: ${uploadResult.originalSize.width}x${uploadResult.originalSize.height} → ${uploadResult.processedSize.width}x${uploadResult.processedSize.height}`
        )
      );
    } catch (error) {
      throw new Error(
        `❌ Failed to upload image: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  const account = jazzClient.getAccount();
  await account?.ensureLoaded({
    resolve: { profile: { joinedSpaces: { $each: true } } },
  });

  // Prepare message options
  const messageOptions: MessageOptions = {};
  if (message.threadId) messageOptions.threadId = message.threadId;
  if (message.replyTo) messageOptions.replyTo = message.replyTo;
  if (imageEmbed) {
    messageOptions.embeds = [imageEmbed];
  }

  // Send message
  console.log(chalk.blue('📨 Sending message...'));
  await jazzClient.sendMessage(space, channel, message.content, messageOptions);

  console.log(chalk.green(`✅ Message sent to #${channel} in ${space}!`));
  await jazzClient.getAccount()?.waitForAllCoValuesSync();
  // Disconnect
  await jazzClient.disconnect();
}
