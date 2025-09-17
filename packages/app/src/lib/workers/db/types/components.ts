// Auto-generated from * tables in schema.ts to mirror component shapes

import type { EntityId } from "./entities";

export type ComponentName =
  | "profile"
  | "config"
  | "page"
  | "upload"
  | "user_access_times"
  | "text_content"
  | "name"
  | "media"
  | "identifier"
  | "description"
  | "url";

export interface BaseComponent {
  entity: EntityId;
  created_at: number;
  updated_at: number;
}

export interface CompProfile extends BaseComponent {
  blueskyHandle: string | null;
  bannerUrl: string | null;
  joinedDate: number | null;
}

export interface CompConfig extends BaseComponent {
  // Stored as TEXT with json_valid(config) constraint
  config: unknown | null;
}

export type CompPage = BaseComponent;

export type UploadType = "image" | "video" | "file";
export type UploadStatus = "pending" | "processing" | "completed" | "failed";

export interface CompUpload extends BaseComponent {
  media_type: UploadType | null;
  status: UploadStatus | null;
  url: string | null;
}

export interface CompUserAccessTimes extends BaseComponent {
  user_created_at: number | null;
  user_updated_at: number | null;
}

export interface CompTextContent extends BaseComponent {
  text: string | null;
  format: string | null;
}

export interface CompName extends BaseComponent {
  name: string | null;
}

export interface CompMedia extends BaseComponent {
  mime_type: string | null;
  width: number | null;
  height: number | null;
  uri: string | null;
}

export interface CompIdentifier extends BaseComponent {
  public_key: Uint8Array | null;
}

export interface CompDescription extends BaseComponent {
  description: string | null;
}

export interface CompUrl extends BaseComponent {
  url: string | null;
}

export type ComponentMap = {
  profile: CompProfile;
  config: CompConfig;
  page: CompPage;
  upload: CompUpload;
  user_access_times: CompUserAccessTimes;
  text_content: CompTextContent;
  name: CompName;
  media: CompMedia;
  identifier: CompIdentifier;
  description: CompDescription;
  url: CompUrl;
};

/** Given one or two tuples of component names, produces a record whose keys are exactly
 * those component names and whose values are the corresponding component types.
 * First parameter lists REQUIRED component names. Second lists OPTIONAL names.
 * Result keys are the union of required and optional, with required taking precedence.
 */
export type ComponentsRecord<
  TRequired extends readonly ComponentName[],
  TOptional extends readonly Exclude<ComponentName, TRequired[number]>[] = [],
> = {
  [K in TRequired[number]]: ComponentMap[K];
} & {
  [K in TOptional[number]]?: ComponentMap[K];
};

// type to get only the non-base fields of a component
export type ComponentNonBaseFields<TComponentName extends ComponentName> = Pick<
  ComponentMap[TComponentName],
  Exclude<keyof ComponentMap[TComponentName], keyof BaseComponent>
>;
