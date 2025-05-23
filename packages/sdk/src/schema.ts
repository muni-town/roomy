import { Account, Profile, coField, co, z, Group } from "jazz-tools";

export const BasicMeta = co.map({
    name: z.string(),
    slug: z.string().optional(),
    description: z.string().optional(),
    image: z.string().optional(),
    createdDate: z.number().optional(),
    updatedDate: z.number().optional(),
});

export const Handles = co.list(z.string());

export const ReplyTo = co.map({
    entity: z.string(),
});

export const ImageUri = co.map({
    uri: z.string(),
    width: z.number().optional(),
    height: z.number().optional(),
    alt: z.string().optional(),
});

export const Images = co.list(z.string());

export const Spaces = co.list(z.string());
export const Collection = co.list(z.string());

export const Channels = co.list(z.string());

export const Threads = co.list(z.string());
export const WikiPages = co.list(z.string());
export const Timeline = co.list(z.string());
export const AuthorUris = co.list(z.string());

export const SpaceSidebarNavigation = co.list(z.string());
export const Admins = co.list(z.string());
// export const Bans = co.map({
//     [id: z.string()]: z.boolean().optional(),
// });
export const Reactions = co.list(z.string());

export type ChannelAnnouncementKind =
  | "messageMoved"
  | "messageDeleted"
  | "threadCreated"
  | string;

export const ChannelAnnouncement = co.map({
    kind: z.string()
});
