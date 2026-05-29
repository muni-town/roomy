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

export async function editMessage(
  spaceId: string,
  roomId: string,
  messageId: string,
  body: string,
  opts: { mimeType?: string } = {},
): Promise<string> {
  const id = newUlid();
  const event: Record<string, unknown> = {
    id,
    room: roomId,
    $type: "space.roomy.message.editMessage.v0",
    messageId,
    body: {
      mimeType: opts.mimeType ?? "text/markdown",
      data: toBytes(new TextEncoder().encode(body)),
    },
  };

  await sendEvents(spaceId, [event]);
  return id;
}

export async function deleteMessage(
  spaceId: string,
  roomId: string,
  messageId: string,
): Promise<string> {
  const id = newUlid();
  const event: Record<string, unknown> = {
    id,
    room: roomId,
    $type: "space.roomy.message.deleteMessage.v0",
    messageId,
  };

  await sendEvents(spaceId, [event]);
  return id;
}
