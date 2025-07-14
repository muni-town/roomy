import chalk from 'chalk';
import { OAuthSessionManager } from './oauth-session-manager';
import { CliSessionData, JazzAccountCredentials } from './stores';

export async function getCredentials(options: { worker?: string }) {
  const sessionManager = new OAuthSessionManager();
  let credentials: JazzAccountCredentials;
  let session: CliSessionData | null = null;
  if (options.worker) {
    console.log(chalk.yellow('🎵 Using Jazz Server Worker: ' + options.worker));

    let worker = await sessionManager.getJazzCredentials(options.worker);
    if (!worker) {
      console.error(
        chalk.red('❌ Jazz Server Worker not found. Please create one first.')
      );
      process.exit(1);
    }

    console.log(
      chalk.green('🎵 Using Jazz Server Worker: ' + worker.publicName)
    );

    credentials = worker.credentials;
  } else {
    session = await sessionManager.loadSession();
    const passphrase =
      session?.jazzWorker.credentials.type === 'passphrase'
        ? session?.jazzWorker.credentials.passphrase
        : '';
    if (passphrase) {
      credentials = {
        type: 'passphrase',
        passphrase,
      };
    } else {
      throw new Error('❌ No Jazz passphrase found. Please log in again.');
    }
  }

  // Check authentication
  if (!credentials) {
    throw new Error('❌ Not logged in. Run: roomy login');
  }

  return credentials;
}
