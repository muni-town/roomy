import {
  Embeds,
  Folder,
  MessageMeta,
  Reactions,
  SpaceMeta,
  RichText,
  Timeline,
} from "./components";
import { bundle } from "./entity";

export const Space = bundle({ meta: SpaceMeta, folder: Folder });
export const Message = bundle({
  meta: MessageMeta,
  embeds: Embeds,
  reactions: Reactions,
  body: RichText,
});

export const Thread = bundle({
  timeline: Timeline,
});
