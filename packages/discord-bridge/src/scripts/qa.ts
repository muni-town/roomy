/**
 * Manual QA walkthrough for the Discord bridge.
 *
 * Just a series of prompts to walk through a happy-path scenario.
 * Press Enter to advance through each step. Ctrl+C to abort.
 *
 * Usage:
 *   bun run src/scripts/qa.ts
 */

import * as readline from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"

const rl = readline.createInterface({ input, output })

let stepNum = 0

async function step(text: string) {
  stepNum += 1
  await rl.question(`\n[${stepNum}] ${text}\n    ↵ `)
}

function section(title: string) {
  console.log(`\n=== ${title} ===`)
}

async function run() {
  console.log("Discord bridge QA walkthrough")
  console.log("Press Enter after completing each step. Ctrl+C to abort.")

  section("Setup")
  await step(
    "Confirm: the bridge is running against staging (slash commands registered, " +
      "logs streaming). You are signed into the Discord test server and the Roomy app."
  )

  section("Connect a new space")
  await step(
    "In the Roomy app, create a new space. Copy its DID to your clipboard."
  )
  await step(
    "In Discord, run: /connect-roomy-space space-id:<paste DID>\n" +
      "    Confirm the bot replies with success."
  )
  await step(
    "In Discord, run: /roomy-status\n" +
      "    Confirm the new space is listed and mode is 'full'."
  )

  section("Channel sync")
  await step("In Discord, create a new text channel called 'qa-1'.")
  await step(
    "In the Roomy app, open the connected space. Confirm 'qa-1' appears in the sidebar."
  )

  section("Messages")
  await step(
    "In Discord #qa-1, send a message: 'hello from discord'. Confirm it appears in Roomy."
  )
  await step("Edit that message in Discord. Confirm the edit appears in Roomy.")
  await step(
    "Add a 👍 reaction in Discord. Confirm the reaction appears in Roomy."
  )
  await step(
    "Delete the message in Discord. Confirm it disappears (or is marked deleted) in Roomy."
  )

  section("Threads")
  await step(
    "In Discord #qa-1, send a new message and create a thread off it called 'qa-thread'."
  )
  await step("In Roomy, confirm 'qa-thread' appears as a child room of qa-1.")
  await step(
    "Send a message in the Discord thread. Confirm it appears in the Roomy thread."
  )

  section("Profile sync")
  await step(
    "Change your Discord server nickname (or avatar). Send a new message in #qa-1. " +
      "Confirm the updated name/avatar appears in Roomy."
  )

  section("Channel rename")
  await step(
    "In Discord, rename 'qa-1' to 'qa-1-renamed'. Confirm the rename appears in Roomy."
  )

  section("Disconnect")
  await step(
    "In Discord, run: /disconnect-roomy-space space-id:<DID>\n" +
      "    Then run /roomy-status and confirm the space is no longer listed."
  )

  console.log("\nQA walkthrough complete.")
  rl.close()
}

run().catch((err) => {
  console.error(err)
  rl.close()
  process.exit(1)
})
