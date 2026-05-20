import { newUlid } from "@roomy-space/sdk";
import { sendEvents } from "./send-events";

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createInvite(spaceId: string): Promise<string> {
  const token = randomToken();
  await sendEvents(spaceId, [
    {
      id: newUlid(),
      $type: "space.roomy.space.createInvite.v0",
      token,
    },
  ]);
  return token;
}

export async function revokeInvite(spaceId: string, token: string): Promise<void> {
  await sendEvents(spaceId, [
    {
      id: newUlid(),
      $type: "space.roomy.space.revokeInvite.v0",
      token,
    },
  ]);
}
