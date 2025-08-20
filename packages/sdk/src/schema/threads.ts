import { co, z } from "jazz-tools";
import { defComponent, RoomyEntity } from "./roomyentity";

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

export const Timeline = co.feed(z.string());

export const ThreadContent = co.map({
  timeline: Timeline,
});

export const ThreadComponent = defComponent(
  "space.roomy.thread.v0",
  ThreadContent,
);

export const SubThreadsComponent = defComponent(
  "space.roomy.subthreads.v0",
  co.feed(RoomyEntity),
);

export const CommonMarkContentComponent = defComponent(
  "space.roomy.content.commonmark.v0",
  co.map({
    content: z.string(),
  }),
);

export const PlainTextContentComponent = defComponent(
  "space.roomy.content.plaintext.v0",
  co.map({
    content: z.string(),
  }),
);

/** note that Jazz also tracks access times for all CoValues;
  this component allows manual override of access times */
export const UserAccessTimesComponent = defComponent(
  "space.roomy.useraccesstimes.v0",
  co.map({
    createdAt: z.date(),
    updatedAt: z.date(),
  }),
);

/** list of thread IDs where message should be hidden */
export const HiddenInComponent = defComponent(
  "space.roomy.hiddenin.v0",
  co.map({
    hiddenIn: co.list(z.string()),
  }),
);

export const EmbedsComponent = defComponent(
  "space.roomy.embeds.v0",
  co.map({
    embeds: co.list(Embed),
  }),
);

export const ReactionsComponent = defComponent(
  "space.roomy.reactions.v0",
  co.map({
    reactions: ReactionList,
  }),
);

/**  ID of the message that this message is a reply to */
export const ReplyToComponent = {
  id: "space.roomy.replyto.v0",
};

/**  optional author override */
export const AuthorComponent = defComponent(
  "space.roomy.author.v0",
  co.map({
    authorId: z.string().optional(),
    name: z.string().optional(),
    imageUrl: z.string().optional(),
    description: z.string().optional(),
  }),
);

/**  ID of the thread that branches off this message */
export const BranchThreadIdComponent = {
  id: "space.roomy.branchthreadid.v0",
};
