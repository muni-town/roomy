import { newUlid, toBytes } from "@roomy-space/sdk";
import { sendEvents } from "./send-events";

export async function sendMessage(
  spaceId: string,
  roomId: string,
  body: string,
  opts: { mimeType?: string; replyTo?: string; mentions?: string[] } = {},
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

  const extensions: Record<string, unknown> = {};
  if (opts.mentions && opts.mentions.length > 0) {
    extensions["space.roomy.extension.mentions.v0"] = {
      $type: "space.roomy.extension.mentions.v0",
      mentions: opts.mentions,
    };
  }

  const event: Record<string, unknown> = {
    id,
    room: roomId,
    $type: "space.roomy.message.createMessage.v0",
    body: {
      mimeType: opts.mimeType || "text/markdown",
      data: toBytes(new TextEncoder().encode(body)),
    },
    extensions,
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
  opts: { mimeType?: string; mentions?: string[] } = {},
): Promise<string> {
  const id = newUlid();
  const extensions: Record<string, unknown> = {};
  if (opts.mentions && opts.mentions.length > 0) {
    extensions["space.roomy.extension.mentions.v0"] = {
      $type: "space.roomy.extension.mentions.v0",
      mentions: opts.mentions,
    };
  }

  const event: Record<string, unknown> = {
    id,
    room: roomId,
    $type: "space.roomy.message.editMessage.v0",
    messageId,
    body: {
      mimeType: opts.mimeType ?? "text/markdown",
      data: toBytes(new TextEncoder().encode(body)),
    },
    ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
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
