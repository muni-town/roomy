import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { OAuthSessionManager } from '../../auth/oauth-session-manager.js';

export const loginCommand = new Command('login')
  .description('Login to Roomy using AT Protocol')
  .option(
    '-h, --handle <handle>',
    'AT Protocol handle (e.g., user.bsky.social)'
  )
  .action(async (options: { handle?: string }) => {
    try {
      const handle = await login(options.handle);
      console.log(chalk.green(`✅ Successfully logged in as ${handle}`));
      console.log(chalk.gray('You can now send messages using: roomy send'));
    } catch (error) {
      console.error(chalk.red(`❌ Login failed: ${(error as Error).message}`));
      process.exit(1);
    }
  });

export async function login(handle?: string) {
  // Check for existing session
  const sessionManager = new OAuthSessionManager();
  const existingSession = await sessionManager.loadSession();
  if (existingSession) {
    const { useExisting } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'useExisting',
        message: `Already logged in as ${existingSession.handle}. Continue with this account?`,
        default: true,
      },
    ]);

    if (useExisting) {
      console.log(
        chalk.green(`✅ Using existing session for ${existingSession.handle}`)
      );
      return;
    }
  }

  // Get handle from user
  if (!handle) {
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'handle',
        message: 'Enter your AT Protocol handle:',
        validate: (input: string) => {
          if (!input.trim()) return 'Handle is required';
          if (!input.includes('.'))
            return 'Handle must be a domain (e.g., user.bsky.social)';
          return true;
        },
      },
    ]);
    handle = answers.handle;
  }

  // Start enhanced OAuth login flow
  await sessionManager.login(handle!);
  return handle;
}
