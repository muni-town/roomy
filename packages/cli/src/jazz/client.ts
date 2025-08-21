import { co, z, Account, Group, ID, cojsonInternals, CoList } from 'jazz-tools';
import {
  RoomyAccount,
  Space,
  Channel,
  Message,
  Thread,
  Embed,
  ImageUrlEmbed,
  VideoUrlEmbed,
  // ReactionList,
  // SpaceList,
  // ChannelList,
  // type SpaceList as SpaceListType,
  Reaction,
  Timeline,
} from './schema.js';
import WebSocket from 'ws';
import { startWorker } from './worker.js';
import {
  uploadMediaToBluesky,
  isSupportedImageFormat,
} from '../bluesky/upload.js';
import { Agent } from '@atproto/api';
import * as bip39 from '@scure/bip39';
import { wordlist } from './wordlist.js';
import { WasmCrypto } from 'cojson/crypto/WasmCrypto';
import { JazzAccountCredentials } from '../auth/stores.js';

// Add WebSocket support for Node.js
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = WebSocket as any;
}

export class RoomyJazzClient {
  private context: any = null;
  private account: Account | null = null;
  private initialized = false;

  async initialize(credentials: JazzAccountCredentials): Promise<void> {
    try {
      console.log('🎵 Initializing Jazz client...');

      let crypto = (await WasmCrypto.create()) as any;
      let accountID, accountSecret;

      if (credentials.type === 'passphrase') {
        let secretSeed;

        try {
          secretSeed = bip39.mnemonicToEntropy(
            credentials.passphrase,
            wordlist
          );
        } catch (e) {
          throw new Error('Invalid passphrase');
        }

        accountSecret = crypto.agentSecretFromSecretSeed(secretSeed);

        accountID = cojsonInternals.idforHeader(
          cojsonInternals.accountHeaderForInitialAgentSecret(
            accountSecret,
            crypto
          ),
          crypto
        ) as ID<Account>;
      }

      console.log(
        '   Jazz Cloud Peer: wss://cloud.jazz.tools/?key=zicklag@katharostech.com'
      );
      console.log('   Account ID:', accountID);
      console.log('   Account Secret:', accountSecret.slice(0, 10) + '...');

      type WorkerOptions = Parameters<typeof startWorker>[0];
      const workerOptions: WorkerOptions = {
        accountID,
        accountSecret: accountSecret,
        syncServer: 'wss://cloud.jazz.tools/?key=zicklag@katharostech.com',
        WebSocket,
        AccountSchema: RoomyAccount,
        crypto,
      };

      const worker = await startWorker(workerOptions);
      this.account = worker.worker;

      await worker.waitForConnection();
      this.initialized = true;
      console.log('✅ Jazz client initialized');
    } catch (error) {
      console.error('❌ Failed to initialize Jazz client:', error);
      throw new Error(
        `Jazz initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async loadSpaces() {
    if (!this.initialized || !this.account?.profile) {
      throw new Error('Client not initialized');
    }

    try {
      const account = this.getAccount();
      await account?.ensureLoaded({
        resolve: {
          profile: {
            joinedSpaces: { $each: { members: true, channels: true } },
            roomyInbox: true,
          },
        },
      });
      const spaces = account?.profile?.joinedSpaces;
      return spaces;
    } catch (error) {
      console.error('❌ Failed to load spaces:', error);
      throw new Error(
        `Failed to load spaces: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async loadChannels(spaceId: string) {
    if (!this.initialized || !this.account?.profile) {
      throw new Error('Client not initialized');
    }

    try {
      console.log(`📡 Loading channels for space ${spaceId}...`);

      const account = this.getAccount();
      await account?.ensureLoaded({
        resolve: {
          profile: {
            joinedSpaces: {
              $each: { members: true, channels: { $each: true } },
            },
            roomyInbox: true,
          },
        },
      });

      console.log('spaceId', spaceId);

      // Find the space
      const targetSpace = await Space.load(spaceId, {
        resolve: { channels: { $each: true } },
      });

      if (!targetSpace) {
        throw new Error(`Space ${spaceId} not found`);
      }

      // Load channels from the space
      const channels = targetSpace.channels;

      console.log(`✅ Loaded ${channels.length} channels`);
      return channels;
    } catch (error) {
      console.error('❌ Failed to load channels:', error);
      throw new Error(
        `Failed to load channels: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async uploadMedia(
    agent: Agent,
    filePath: string,
    options: {
      maxSize?: number;
      quality?: number;
    } = {}
  ): Promise<{
    url: string;
    originalSize: { width: number; height: number };
    processedSize: { width: number; height: number };
  }> {
    try {
      console.log(`📸 Uploading image: ${filePath}`);

      // Validate file format
      if (!isSupportedImageFormat(filePath)) {
        throw new Error(
          'Unsupported image format. Supported formats: jpg, jpeg, png, gif, webp, bmp'
        );
      }

      // Upload to Bluesky CDN
      const result = await uploadMediaToBluesky(agent, filePath, {
        maxSize: options.maxSize || 2048,
        quality: options.quality || 85,
        mediaType: 'image',
      });

      return {
        url: result.url,
        originalSize: result.originalSize!,
        processedSize: result.processedSize!,
      };
    } catch (error) {
      console.error('❌ Failed to upload image:', error);
      throw new Error(
        `Failed to upload image: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async createThread(channelId: string, messagesIds: string[], name?: string) {
    if (!this.initialized || !this.account) {
      throw new Error('Client not initialized');
    }

    try {
      console.log(`📨 Creating thread in channel ${channelId}...`);

      const publicWriteGroup = publicGroup('writer');
      const publicReadGroup = publicGroup('reader');

      const thread = Thread.create(
        {
          name: name || 'New Thread',
          timeline: Timeline.create([...messagesIds], publicWriteGroup),
          channelId,
        },
        publicReadGroup
      );

      const channel = await Channel.load(channelId, {
        resolve: { subThreads: { $each: true } },
      });
      if (!channel) {
        throw new Error(`Channel ${channelId} not found`);
      }

      if (!channel.subThreads) {
        channel.subThreads = co.list(Thread).create([], publicReadGroup);
      }
      channel.subThreads?.push(thread);

      console.log('Created thread', thread);

      return thread;
    } catch (error) {
      console.error('❌ Failed to create thread:', error);
      throw new Error(
        `Failed to create thread: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async sendMessage(
    spaceId: string,
    channelId: string,
    content: string,
    options: {
      threadId?: string;
      replyTo?: string;
      embeds?: Array<{ type: 'imageUrl' | 'videoUrl'; url: string }>;
      createdAt?: Date;
    } = {}
  ): Promise<co.loaded<typeof Message>> {
    if (!this.initialized || !this.account) {
      throw new Error('Client not initialized');
    }

    try {
      console.log(`📨 Sending message to channel ${channelId}...`);

      const space = await Space.load(spaceId, {
        resolve: { channels: { $each: true } },
      });

      if (!space) {
        throw new Error(`Space ${spaceId} not found`);
      }

      const adminGroup = await Group.load(space.adminGroupId);

      // Find the channel and its main thread or specified thread
      let targetChannel = await Channel.load(channelId, { resolve: {} });

      if (!targetChannel) {
        throw new Error(`Channel ${channelId} not found`);
      }

      // Load the actual Channel CoValue to send message
      const channelCoValue = await Channel.load(channelId, {
        loadAs: this.account,
        resolve: {
          mainThread: { timeline: true },
          subThreads: { $each: true },
        },
      });

      if (!channelCoValue) {
        throw new Error(`Could not load channel ${channelId}`);
      }

      // Determine which thread to post to
      const targetThread = options.threadId
        ? (channelCoValue as any).subThreads?.find(
            (t: any) => t?.id === options.threadId
          )
        : (channelCoValue as any).mainThread;

      if (!targetThread || !(targetThread as any).timeline) {
        throw new Error('Target thread not found or has no timeline');
      }

      const readingGroup = publicGroup('reader');

      // Create embeds if provided
      let embedsList: any = undefined;
      if (options.embeds && options.embeds.length > 0) {
        embedsList = co.list(Embed).create([], readingGroup);
        for (const embed of options.embeds) {
          if (embed.type === 'imageUrl') {
            const imageEmbed = ImageUrlEmbed.create(
              { url: embed.url },
              readingGroup
            );
            const embedObj = Embed.create(
              {
                type: 'imageUrl' as const,
                embedId: imageEmbed.id,
              },
              readingGroup
            );
            embedsList.push(embedObj);
          } else if (embed.type === 'videoUrl') {
            const videoEmbed = VideoUrlEmbed.create(
              { url: embed.url },
              readingGroup
            );
            const embedObj = Embed.create(
              {
                type: 'videoUrl' as const,
                embedId: videoEmbed.id,
              },
              readingGroup
            );
            embedsList.push(embedObj);
          }
        }
      }

      // Create the message
      const message = createMessage(
        content,
        options.replyTo,
        adminGroup || undefined,
        embedsList,
        options.createdAt
      );

      // Add message to timeline
      (targetThread as any).timeline.push(message.id);

      console.log(`✅ Message sent successfully to ${targetChannel.name}`);

      return message;
    } catch (error) {
      console.error('❌ Failed to send message:', error);
      throw new Error(
        `Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async disconnect(): Promise<void> {
    if (this.context) {
      // Jazz context cleanup
      this.context = null;
    }
    this.account = null;
    this.initialized = false;
    console.log('👋 Jazz client disconnected');
  }

  getAccount() {
    return this.account?.castAs(RoomyAccount) ?? null;
  }
}

export function publicGroup(readWrite: 'reader' | 'writer' = 'reader') {
  const group = Group.create();
  group.addMember('everyone', readWrite);

  return group;
}

export function createMessage(
  input: string,
  replyTo?: string,
  admin?: co.loaded<typeof Group>,
  embedsList?: co.loaded<typeof CoList<co.loaded<typeof Embed>>>,
  createdAt?: Date
) {
  const readingGroup = publicGroup('reader');

  if (admin) {
    readingGroup.extend(admin);
  }

  const publicWriteGroup = publicGroup('writer');

  const message = Message.create(
    {
      content: input,
      createdAt: createdAt || new Date(),
      updatedAt: new Date(),
      reactions: co.list(Reaction).create([], publicWriteGroup),
      replyTo: replyTo,
      hiddenIn: co.list(z.string()).create([], readingGroup),
      embeds: embedsList,
    },
    readingGroup
  );

  return message;
}
