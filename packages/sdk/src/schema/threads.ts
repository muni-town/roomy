import { co, z } from "jazz-tools";
import { RoomyEntity } from "./roomyentity";

export const Reaction = co.map({
  emoji: z.string(),
});

export const ReactionList = co.list(Reaction);

export const ImageUrlEmbed = co.map({
  url: z.string(),
});

export const VideoUrlEmbed = co.map({
  url: z.string(),
});

export const Embed = co.map({
  type: z.enum(["imageUrl", "videoUrl"]),
  embedId: z.string(),
});

export const Message = co.map({
  content: z.string(),

  createdAt: z.date(),
  updatedAt: z.date(),

  hiddenIn: co.list(z.string()),

  replyTo: z.string().optional(),
  reactions: ReactionList,

  softDeleted: z.boolean().optional(),

  embeds: z.optional(co.list(Embed)),

  author: z.string().optional(),

  threadId: z.string().optional(),
});

export const Timeline = co.feed(z.string());

export const ThreadContent = co.map({
  timeline: Timeline,
});

export const ThreadComponent = {
  schema: ThreadContent,
  id: "space.roomy.thread.v0",
};

export const SubThreadsComponent = {
  schema: co.feed(RoomyEntity),
  id: "space.roomy.subthreads.v0",
};

// ID of the message that starts a subthread
export const ThreadRootComponent = {
  id: "space.roomy.threadroot.v0"
};
