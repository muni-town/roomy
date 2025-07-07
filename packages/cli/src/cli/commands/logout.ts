import { Command } from 'commander';
import chalk from 'chalk';
import { OAuthSessionManager } from '../../auth/oauth-session-manager.js';

export const logoutCommand = new Command('logout')
  .description('Logout from Roomy')
  .action(async () => {
    const sessionManager = new OAuthSessionManager();
    
    try {
      const session = await sessionManager.loadSession();
      if (!session) {
        console.log(chalk.yellow('⚠️  No active session found'));
        return;
      }
      
      await sessionManager.clearSession();
      console.log(chalk.green('✅ Successfully logged out'));
      
    } catch (error) {
      console.error(chalk.red(`❌ Logout failed: ${(error as Error).message}`));
      process.exit(1);
    }
  });