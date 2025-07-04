import { createMessage, Timeline, co, Group } from "@roomy-chat/sdk";

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
