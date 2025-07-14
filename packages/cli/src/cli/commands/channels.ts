import { Command } from 'commander';
import chalk from 'chalk';
import { OAuthSessionManager } from '../../auth/oauth-session-manager.js';
import { RoomyJazzClient } from '../../jazz/client.js';
import { CliSessionData } from '../../auth/stores.js';
import { getCredentials } from '../../auth/utils.js';

export const channelsCommand = new Command('channels')
  .description('List channels in a space')
  .requiredOption('-s, --space <space>', 'Space name or ID')
  .option('-w, --worker <handle>', 'Use Jazz Server Worker')
  .action(async (options) => {
    const jazzClient = new RoomyJazzClient();
    try {
      let credentials = await getCredentials(options);

      // Check authentication
      if (!credentials) {
        console.error(chalk.red('❌ Not logged in. Run: roomy login'));
        process.exit(1);
      }

      // Initialize Jazz client
      console.log(chalk.blue('🎵 Connecting to Jazz...'));

      await jazzClient.initialize(credentials);

      console.log(chalk.blue('🎵 Loading channels...'));
      // Find the space
      const spaces = await jazzClient.loadSpaces();

      if (!spaces) {
        console.error(chalk.red('❌ No spaces found.'));
        process.exit(1);
      }

      const selectedSpace = spaces.find(
        (s) => s?.id === options.space || s?.name === options.space
      );

      if (!selectedSpace) {
        console.error(chalk.red(`❌ Space "${options.space}" not found.`));
        console.log(chalk.gray('Available spaces:'));
        for (const space of spaces) {
          console.log(`  - ${space?.name} (${space?.id})`);
        }
        process.exit(1);
      }

      // Get channels
      const channels = await jazzClient.loadChannels(selectedSpace.id);

      if (channels.length === 0) {
        console.log(
          chalk.yellow(`📭 No channels found in "${selectedSpace.name}".`)
        );
        return;
      }

      console.log(
        chalk.green(
          `\n💬 Channels in "${selectedSpace.name}" (${channels.length}):`
        )
      );
      console.log(chalk.gray('─'.repeat(50)));

      for (const channel of channels) {
        const threadCount = channel.subThreads?.length || 0;
        const hasPages = channel.pages && channel.pages.length > 0;

        console.log(`${chalk.cyan('#')} ${chalk.bold(channel.name)}`);
        console.log(`  ${chalk.gray('ID:')} ${channel.id}`);
        console.log(`  ${chalk.gray('Threads:')} ${threadCount}`);
        if (hasPages) {
          console.log(`  ${chalk.gray('Pages:')} ${channel.pages!.length}`);
        }
        console.log('');
      }

      // Disconnect
      await jazzClient.disconnect();
    } catch (error) {
      console.error(
        chalk.red(
          `❌ Failed to load channels: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
      );
      process.exit(1);
    }
  });
