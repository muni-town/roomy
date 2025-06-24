import { createMessage } from "./utils.js";
import { Timeline } from "./schema.js";
import { co, Group } from "jazz-tools";

export async function sendMessage(timeline: co.loaded<typeof Timeline>, messageInput: string, author: string, avatarUrl: string, admin: Group) {

  const message = createMessage(
    messageInput,
    undefined,
    admin,
  );

  message.author = `discord:${author}:${encodeURIComponent(avatarUrl)}`;

  if (timeline) {
    timeline.push(message.id);
  }
}
