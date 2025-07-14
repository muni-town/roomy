import { Command } from 'commander';
import chalk from 'chalk';
import { RoomyJazzClient } from '../../jazz/client.js';
import { getCredentials } from '../../auth/utils.js';
import { JazzAccountCredentials } from '../../auth/stores.js';

export const spacesCommand = new Command('spaces')
  .description('List joined spaces')
  .option('-w, --worker <handle>', 'Use Jazz Server Worker')
  .action(async (options) => {
    try {
      let credentials = await getCredentials(options);

      // Initialize Jazz client
      console.log(chalk.blue('🎵 Connecting to Jazz...'));

      await listSpaces(credentials);
    } catch (error) {
      console.error(
        chalk.red(
          `❌ Failed to load spaces: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
      );
      process.exit(1);
    }
  });

export async function listSpaces(credentials: JazzAccountCredentials) {
  const jazzClient = new RoomyJazzClient();
  await jazzClient.initialize(credentials);

  const spaces = await jazzClient.loadSpaces();

  if (!spaces) {
    console.log(
      chalk.yellow(
        '📭 No spaces found. Join a space first on https://roomy.space'
      )
    );
    process.exit(0);
  }

  if (spaces?.length === 0) {
    console.log(
      chalk.yellow(
        '📭 No spaces found. Join a space first on https://roomy.space'
      )
    );
    process.exit(0);
  }

  console.log(chalk.green(`\n📌 Your spaces (${spaces.length}):`));
  console.log(chalk.gray('─'.repeat(50)));

  for (const space of spaces) {
    if (!space) {
      continue;
    }
    const memberCount = space?.members?.length || 0;
    const channelCount = space?.channels?.length || 0;

    console.log(`${chalk.cyan('●')} ${chalk.bold(space?.name)}`);
    console.log(`  ${chalk.gray('ID:')} ${space?.id}`);
    console.log(`  ${chalk.gray('Members:')} ${memberCount}`);
    console.log(`  ${chalk.gray('Channels:')} ${channelCount}`);
    if (space.description) {
      console.log(`  ${chalk.gray('Description:')} ${space.description}`);
    }
    console.log('');
  }

  // Disconnect
  await jazzClient.disconnect();
}
