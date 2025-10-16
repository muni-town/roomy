export type ThreadInfo = {
  id: string;
  name: string;
  kind: "channel" | "thread";
  channel?: string;
  activity: {
    members: { avatar?: string; name: string }[];
    latestTimestamp: number;
  };
};
