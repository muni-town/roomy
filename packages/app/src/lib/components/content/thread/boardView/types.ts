export type ThreadInfo = {
  id: string;
  name: string;
  channel?: string;
  activity: {
    members: { avatar?: string; name: string; }[];
    latestTimestamp: number;
  };
};
