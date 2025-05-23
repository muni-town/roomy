import { Account, Profile as P, coField, co, z, Group, type Loaded } from "jazz-tools";

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


export const Profile = co.map({
    handle: z.string(),
    avatarUrl: z.string(),
    displayName: z.string()
})


export const Message = co.map({
    replyTo: z.string(),
    softDeleted: z.boolean(),
    body: z.string(),
    profile: Profile,
    createdDate: z.date()
})



export const Channel = co.map({
    name: z.string(),
    softDeleted: z.boolean().optional(),
    messages: z.optional(co.list(Message))
})

export const Image = co.map({
    uri: z.string(),
})
export const Space = co.map({
    name: z.string(),
    channels: z.optional(co.list(Channel)),
    image: z.optional(Image),
}).withHelpers((Self) => ({
    sidebarItems(space: Loaded<typeof Self>) {
        return space.channels
    }

}))
export const Thread = co.map({
    name: z.string(),
    softDeleted: z.boolean(),
    messages: co.list(Message)
})

export const Category = co.map({
    name: z.string(),
    channels: z.optional(co.list(Channel))
})

export type Space = Loaded<typeof Space>
export type Profile = Loaded<typeof Profile>
export type Message = Loaded<typeof Message>
export type Channel = Loaded<typeof Channel>
export type Thread = Loaded<typeof Thread>
export type Category = Loaded<typeof Category>
export type Image = Loaded<typeof Image>

