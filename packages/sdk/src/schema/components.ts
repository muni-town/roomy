import { co, z } from "jazz-tools";
import { Entity } from "./entity";
import { defComponent } from "./entity";

export const Reaction = co.map({
  emoji: z.string(),
});

export const Reactions = defComponent(
  "reactions_01K07S73AD9CJW180ER4ZPQGXT",
  co.list(Reaction),
);

export const RemoteImage = defComponent(
  "remote-image_01K07SCCZVNEN2Z95BRRQ4Y8V1",
  co.map({
    url: z.string(),
  }),
);

export const RemoteVideo = defComponent(
  "remote-video_01K07SB796Z6PC8V02GP5ZK5NZ",
  co.map({
    url: z.string(),
  }),
);

export const Embeds = defComponent(
  "embed_01K07S7XCCKF25J9B3D9Y88E1P",
  co.list(Entity),
);

export const CommonMark = defComponent(
  "space.roomy.commonmark.v0",
  co.map({
    text: z.string(),
  }),
);

export const PlainText = defComponent(
  "plain-text_01K07SDYCTSTPMETNME74WNA7N",
  co.map({
    text: z.string(),
  }),
);

export const RichText = defComponent(
  "rich-text_01K07T8QHM9QZ7C30P43FBDE1G",
  co.map({
    richText: co.richText(),
  }),
);

export const MessageMeta = defComponent(
  "message-meta_01K07SF6Q2WRVPQ89SX23EAYJ8",
  co.map({
    hiddenIn: co.list(z.string()),

    replyTo: z.string().optional(),

    author: z.string().optional(),

    threadId: z.string().optional(),
  }),
);

export const Timeline = defComponent(
  "timeline_01K07S3SEZ76ZPF8EZZ8Y9V14G",
  co.feed(Entity),
);

export const Folder = defComponent(
  "folder_01K07T2KXYNSY7ACWSKXZ299MA",
  co.map({
    children: co.list(z.string()),
  }),
);

export const SpaceMeta = defComponent(
  "space-meta_01K07R9GVFTQ6NBZHMXX2KC8BC",
  co.map({
    members: co.list(co.account()),

    adminGroupId: z.string(),

    threads: co.feed(Entity),
    pages: co.list(Entity),
    folders: co.list(Entity),

    bans: co.list(z.string()),
  }),
);
