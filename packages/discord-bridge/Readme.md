# Discord Bridge for Roomy

A microservice that enables bidirectional message synchronization between Roomy spaces and Discord servers.

## Architecture

The Discord Bridge consists of:
- **Express REST API Server** (`server.ts`) - Manages bridge configurations and validation
- **Bridge Engine** (`index.ts`) - Handles active Discord connections and message routing
- **Admin UI** - Web interface for managing bridges (in main Roomy app)

## Setup & Configuration

### 1. Environment Variables
Create `.env` file in the discord-bridge package:
```bash
# Discord Bridge Service
PORT=3301

# Jazz Integration (for syncing with Roomy spaces)
JAZZ_WORKER_ACCOUNT=your_worker_account_id
JAZZ_WORKER_SECRET=your_worker_secret
JAZZ_API_KEY=your_jazz_api_key
```

### 2. Running the Service
```bash
cd packages/discord-bridge
npm install
npm run dev
```

Service will start on http://localhost:3301

## Usage

### Creating a Discord Bridge

1. **Setup Discord Bot:**
   - Create a Discord application at https://discord.com/developers/applications
   - Create a bot and copy the bot token
   - Add bot to your Discord server with appropriate permissions
   - Get your Discord Guild (Server) ID

2. **Configure Bridge in Roomy:**
   - Navigate to Admin → Discord Bridge in the Roomy app
   - Click "New Bridge"
   - Fill in:
     - Bridge Name
     - Discord Bot Token
     - Discord Guild ID
     - Select Roomy Space and Channel
   - Click "Create Bridge"

3. **Enable Bridge:**
   - Click "Enable" on the created bridge
   - Messages will now sync bidirectionally

## API Endpoints

### Health & Status
- `GET /health` - Service health check
- `GET /status` - Active bridge count and system info

### Discord Validation
- `POST /validate-discord` - Validate Discord bot token and guild access
  ```json
  {
    "discordToken": "your_bot_token",
    "guildId": "discord_guild_id"
  }
  ```

### Bridge Management
- `POST /bridges` - Start a new bridge
- `DELETE /bridges/:id` - Stop a bridge
- `GET /bridges` - List active bridges

## Features

### Current Implementation
- REST API for bridge management
- Discord bot token validation
- Bidirectional message sync (Discord ↔ Roomy)
- Admin UI with space/channel selection
- Bridge status monitoring
- User permission validation (space admin/creator only)
- Persistent bridge configurations
- Toast notifications and error handling
- Webhook-based Discord message sending

### Message Routing
1. **Discord → Roomy:**
   - Listens for Discord message events
   - Sends to corresponding Roomy channel via Jazz
   - Preserves author name and avatar

2. **Roomy → Discord:**
   - Monitors Roomy channel timeline
   - Sends to Discord via webhooks
   - Maintains message formatting
