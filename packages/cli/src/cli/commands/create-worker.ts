import { createWorkerAccount } from 'jazz-run/createWorkerAccount';
import { Command } from 'commander';
import chalk from 'chalk';
import { OAuthSessionManager } from '../../auth/oauth-session-manager.js';
import { RoomyJazzClient } from '../../jazz/client.js';
import { RoomyAccount } from '../../jazz/schema.js';
import { getCredentials } from '../../auth/utils.js';

export const createWorkerCommand = new Command('create-worker')
  .description('Create a worker account')
  .option('-w, --worker <handle>', 'Jazz Server Worker name')
  .action(async (options: { worker?: string }) => {
    const worker = options.worker || 'jazz-test';

    try {
      const credentials = await getCredentials(options);
      const jazzClient = new RoomyJazzClient();
      await jazzClient.initialize(credentials);

      const jazzAccount = jazzClient.getAccount();
      console.log(jazzAccount);

      jazzAccount?.castAs(RoomyAccount);

      if (jazzAccount?.profile) {
        jazzAccount.profile.name = worker;
      }

      await jazzAccount?.waitForAllCoValuesSync();

      console.log(
        chalk.green(`✅ Created and stored Jazz Server Worker: ${worker}`)
      );
      console.log(chalk.gray('You can now send messages using: roomy send'));
      process.exit(0);
    } catch (error) {
      console.error(
        chalk.red(`❌ Failed to create worker: ${(error as Error).message}`)
      );
      process.exit(1);
    }
  });
