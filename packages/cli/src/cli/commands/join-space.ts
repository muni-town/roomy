import { OAuthSessionManager } from '../../auth/oauth-session-manager.js';
import { RoomyJazzClient } from '../../jazz/client.js';
import { CliSessionData, JazzAccountCredentials } from '../../auth/stores.js';
import { Command } from 'commander';
import chalk from 'chalk';
import { Space } from '../../jazz/schema.js';
import { getCredentials } from '../../auth/utils.js';

export const joinSpaceCommand = new Command('join-space')
  .description('Join a space')
  .option('-s, --space <space>', 'Space ID')
  .option('-i, --invite <invite>', 'Invite ID')
  .option('-w, --worker <handle>', 'Use Jazz Server Worker')
  .action(async (options) => {
    try {
      const credentials = await getCredentials(options);
      const jazzClient = new RoomyJazzClient();
      await jazzClient.initialize(credentials);

      // Get account
      const account = jazzClient.getAccount();
      if (!account) {
        console.error(chalk.red('❌ No account found. Please log in again.'));
        process.exit(1);
      }

      account.ensureLoaded({ resolve: { profile: true } });

      if (!options.space) {
        console.error(chalk.red('❌ No space ID provided.'));
        process.exit(1);
      }

      let loadedSpace = await Space.load(options.space, {
        resolve: { channels: true, members: true },
      });

      if (!loadedSpace) {
        console.error(chalk.red('❌ Space not found.'));
        process.exit(1);
      }

      console.log(loadedSpace);
      console.log(chalk.green('🎵 Joining space: ' + options.space));

      console.log(account);
      await account.ensureLoaded({
        resolve: { profile: { joinedSpaces: { $each: true } } },
      });
      console.log(account.profile);

      account.profile?.joinedSpaces?.push(loadedSpace as any);
      console.log(account.profile?.joinedSpaces);
      await account.ensureLoaded({
        resolve: { profile: { joinedSpaces: { $each: true } } },
      });

      // some kind of problem with access to the added account/profile being unauthorised
      //

      loadedSpace.members?.push(account);
      console.log(chalk.green('✅ Joined space: ' + options.space));
      await account.waitForAllCoValuesSync();
      await jazzClient.disconnect();
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('❌ Failed to join space: ' + error));
      process.exit(1);
    }
  });
