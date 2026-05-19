import { newUlid, toBytes } from "@roomy-space/sdk";
import { sendEvents } from "./send-events";

export async function sendMessage(
  spaceId: string,
  roomId: string,
  body: string,
  opts: { mimeType?: string; replyTo?: string } = {},
): Promise<string> {
  const id = newUlid();
  const attachments = opts.replyTo
    ? [
        {
          $type: "space.roomy.attachment.reply.v0",
          target: opts.replyTo,
        },
      ]
    : undefined;

  const event: Record<string, unknown> = {
    id,
    room: roomId,
    $type: "space.roomy.message.createMessage.v0",
    body: {
      mimeType: opts.mimeType || "text/markdown",
      data: toBytes(new TextEncoder().encode(body)),
    },
    extensions: {},
    ...(attachments ? { attachments } : {}),
  };

  await sendEvents(spaceId, [event]);
  return id;
}
