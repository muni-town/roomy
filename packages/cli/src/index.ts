#!/usr/bin/env node

import { program } from 'commander';
import { loginCommand } from './cli/commands/login.js';
import { logoutCommand } from './cli/commands/logout.js';
import { sendCommand } from './cli/commands/send.js';
import { spacesCommand } from './cli/commands/spaces.js';
import { channelsCommand } from './cli/commands/channels.js';
import { createWorkerCommand } from './cli/commands/create-worker.js';
import { joinSpaceCommand } from './cli/commands/join-space.js';

program
  .name('roomy')
  .description('Roomy CLI - Send messages to Roomy spaces from the command line')
  .version('1.0.0');

program.addCommand(loginCommand);
program.addCommand(logoutCommand);
program.addCommand(sendCommand);
program.addCommand(spacesCommand);
program.addCommand(channelsCommand);
program.addCommand(createWorkerCommand);
program.addCommand(joinSpaceCommand);

// Global error handling
process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled error:', error);
  process.exit(1);
});

program.parse(process.argv);