<script lang="ts">
  import Icon from "@iconify/svelte";
  import { Button } from "bits-ui";
  
  let showInstructions = $state(false);
</script>

<div class="mt-6">
  <Button.Root
    onclick={() => showInstructions = !showInstructions}
    class="dz-btn dz-btn-ghost dz-btn-sm"
  >
    <Icon icon="lucide:help-circle" class="w-4 h-4 mr-2" />
    How to get Discord credentials
    <Icon icon={showInstructions ? "lucide:chevron-up" : "lucide:chevron-down"} class="w-4 h-4 ml-2" />
  </Button.Root>

  {#if showInstructions}
    <div class="mt-4 p-4 bg-base-200 rounded-lg">
      <h3 class="font-semibold mb-4">Setting up Discord Bot</h3>
      
      <div class="space-y-4">
        <div>
          <h4 class="font-medium mb-2">📋 Step 1: Create Discord Application</h4>
          <ol class="list-decimal list-inside space-y-1 text-sm">
            <li>Go to <a href="https://discord.com/developers/applications" target="_blank" class="link link-primary">Discord Developer Portal</a></li>
            <li>Click "New Application" and give it a name</li>
            <li>Go to the "Bot" section in the sidebar</li>
            <li>Click "Add Bot" if not already created</li>
          </ol>
        </div>

        <div>
          <h4 class="font-medium mb-2">🔑 Step 2: Get Bot Token</h4>
          <ol class="list-decimal list-inside space-y-1 text-sm">
            <li>In the Bot section, find the "Token" area</li>
            <li>Click "Reset Token" or "Copy" to get your bot token</li>
            <li><strong>Keep this token secure!</strong> Don't share it publicly</li>
          </ol>
        </div>

        <div>
          <h4 class="font-medium mb-2">⚙️ Step 3: Configure Bot Permissions</h4>
          <p class="text-sm mb-2">Enable these Privileged Gateway Intents:</p>
          <ul class="list-disc list-inside space-y-1 text-sm">
            <li>Message Content Intent</li>
            <li>Server Members Intent (optional)</li>
          </ul>
        </div>

        <div>
          <h4 class="font-medium mb-2">🏠 Step 4: Invite Bot to Your Server</h4>
          <ol class="list-decimal list-inside space-y-1 text-sm">
            <li>Go to the "OAuth2" → "URL Generator" section</li>
            <li>Select "bot" in scopes</li>
            <li>Select these bot permissions:
              <ul class="list-disc list-inside ml-4 mt-1">
                <li>Send Messages</li>
                <li>Manage Webhooks</li>
                <li>Read Message History</li>
                <li>View Channels</li>
              </ul>
            </li>
            <li>Copy the generated URL and visit it to invite the bot</li>
          </ol>
        </div>

        <div>
          <h4 class="font-medium mb-2">🆔 Step 5: Get Guild (Server) ID</h4>
          <ol class="list-decimal list-inside space-y-1 text-sm">
            <li>In Discord, go to User Settings (gear icon)</li>
            <li>Go to "Advanced" and enable "Developer Mode"</li>
            <li>Right-click on your server name</li>
            <li>Click "Copy Server ID"</li>
          </ol>
        </div>

        <div class="dz-alert dz-alert-info">
          <Icon icon="lucide:info" class="w-5 h-5" />
          <div>
            <h3 class="font-bold">Security Note</h3>
            <div class="text-sm">Your Discord bot token is processed securely and is only used to establish the bridge connection. It's not stored permanently on our servers.</div>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>
