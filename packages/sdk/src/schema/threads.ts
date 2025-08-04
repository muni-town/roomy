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

// export const Message = co.map({
//   content: z.string(), // ✅
//   createdAt: z.date(), // ✅
//   updatedAt: z.date(), // ✅
//   hiddenIn: co.list(z.string()), // ✅ // list of thread IDs where message should be hidden
//   replyTo: z.string().optional(), // ✅ // ID of the message that this message is a reply to
//   reactions: ReactionList, // ✅
//   softDeleted: z.boolean().optional(), // ✅
//   embeds: z.optional(co.list(Embed)), // ✅
//   author: z.string().optional(), // ✅ // optional author override
//   threadId: z.string().optional(), // ID of the thread that branches off this message
// });

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

export const PlainTextContentComponent = {
  schema: co.map({
    content: z.string(),
  }),
  id: "space.roomy.content.plaintext.v0",
};

export const UserAccessTimesComponent = {
  // note that Jazz also tracks access times for all CoValues;
  // this component allows manual override of access times
  schema: co.map({
    createdAt: z.date(),
    updatedAt: z.date(),
  }),
  id: "space.roomy.useraccesstimes.v0",
};

export const HiddenInComponent = {
  schema: co.map({
    hiddenIn: co.list(z.string()), // list of thread IDs where message should be hidden
  }),
  id: "space.roomy.hiddenin.v0",
};

export const ReplyToComponent = {
  // ID of the message that this message is a reply to
  id: "space.roomy.replyto.v0",
};

export const ReactionsComponent = {
  schema: co.map({
    reactions: ReactionList,
  }),
  id: "space.roomy.reactions.v0",
};

export const EmbedsComponent = {
  schema: co.map({
    embeds: z.optional(co.list(Embed)),
  }),
  id: "space.roomy.embeds.v0",
};

export const AuthorComponent = {
  // optional author override
  id: "space.roomy.author.v0",
};

export const BranchThreadIdComponent = {
  // ID of the thread that branches off this message
  id: "space.roomy.branchthreadid.v0",
};