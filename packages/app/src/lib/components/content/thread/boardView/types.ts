export type ThreadInfo = {
  id: string;
  name: string;
  kind: "channel" | "thread" | "page";
  channel?: string;
  activity: {
    members: { avatar: string | null; name: string | null; id: string }[];
    latestTimestamp: number;
  };
};
