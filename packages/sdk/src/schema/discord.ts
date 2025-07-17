import { co, z } from "jazz-tools";

export const DiscordBridgeRequest = co.map({
  discordGuildId: z.string(),
  roomySpaceId: z.string(),
  status: z.enum(["requested", "active", "inactive", "error"]),

  error: z.string().optional(),
})

export const DiscordBridgeRequestList = co.list(DiscordBridgeRequest);

export const WorkerProfile = co.profile({
  name: z.string(),
  imageUrl: z.string().optional(),
  description: z.string().optional(),

  requests: DiscordBridgeRequestList,
});

export const WorkerAccount = co.account({
  profile: WorkerProfile,
  root: co.map({}),
});
