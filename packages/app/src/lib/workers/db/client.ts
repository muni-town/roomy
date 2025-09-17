import { schema } from "./schema";
import type { AnyEvent } from "./types/events";
import type {
  CompConfig,
  CompDescription,
  CompName,
  CompProfile,
  CompTextContent,
  CompUpload,
} from "./types/components";
import type { EdgeMember, EdgeReaction, EdgeBan } from "./types/edges";
import { ulid } from "ulidx";
import type { EntityId } from "./types/entities";

export class LeafClient {
  active: string | null = null;
  tabId: string | null = null;
  debug: boolean = false;
  handler: (e: MessageEvent) => void = () => {};
  private sendQuery:
    | ((sql: string, requestId: string) => Promise<unknown>)
    | null = null;
  private sendEvent:
    | ((event: AnyEvent, requestId: string) => Promise<unknown>)
    | null = null;

  private genId() {
    return Math.random().toString(36).slice(2);
  }

  private log(message: string, ...args: unknown[]) {
    if (this.debug) {
      if (Array.isArray(args)) {
        console.log(message, ...args);
      } else {
        console.log(message, args);
      }
    }
  }

  private error(message: string, ...args: unknown[]) {
    if (this.debug) {
      if (Array.isArray(args)) {
        console.error(message, ...args);
      } else {
        console.error(message, args);
      }
    }
  }

  onMount() {
    if (!this.sendQuery) {
      this.sendQuery = window.__sendQuery;
    }
    if (!this.sendEvent) {
      this.sendEvent =
        (
          window as unknown as {
            __sendEvent?: (
              event: AnyEvent,
              requestId: string,
            ) => Promise<unknown>;
          }
        ).__sendEvent || null;
    }
    this.tabId = window.__TAB_ID || null;
    this.active = window.__ACTIVE || null;
    this.handler = (e: MessageEvent) => {
      if (e?.data?.type === "ACTIVE_CHANGED") {
        this.active = e.data.activeTabId;
      }
    };
    window.addEventListener("message", this.handler);
  }

  onUnMount() {
    window.removeEventListener("message", this.handler);
  }

  async run(sql: string) {
    if (!this.sendQuery) {
      this.sendQuery = window.__sendQuery;
    }
    const id = this.genId();
    try {
      const res: Record<string, unknown> = (await this.sendQuery(
        sql,
        id,
      )) as Record<string, unknown>;
      if ("error" in res) {
        this.error(sql, res);
      } else {
        this.log(sql, res);
      }
      return res;
    } catch (e) {
      return String(e);
    }
  }

  async initSchema() {
    this.debug = true;
    await this.run(schema.pragmaLockingMode);
    await this.run(schema.pragmaWal);
    await this.run(schema.pragmaForeignKeys);

    await this.run(schema.createEntitiesTable);
    await this.run(schema.createEntitiesIndex);

    await this.run(schema.createEventsTable);
    await this.run(schema.createEventsIndex);
    await this.run(schema.createEventsIndexEntityCreated);

    await this.run(schema.createEdgesTable);
    await this.run(schema.createEdgesHeadIndex);
    await this.run(schema.createEdgesTailIndex);
    await this.run(schema.createEdgesHeadLabelIndex);
    await this.run(schema.createEdgesTailLabelIndex);

    await this.run(schema.createCompProfileTable);
    await this.run(schema.createCompProfileIndex);

    await this.run(schema.createCompConfigTable);
    await this.run(schema.createCompConfigIndex);

    await this.run(schema.createCompPageTable);

    await this.run(schema.createCompUploadTable);
    await this.run(schema.createCompUploadIndex);

    await this.run(schema.createCompUserAccessTimesTable);
    await this.run(schema.createCompUserAccessTimesCreatedIndex);
    await this.run(schema.createCompUserAccessTimesIndexUpdated);

    await this.run(schema.createCompTextContentTable);
    await this.run(schema.createCompTextContentIndex);
    await this.run(schema.createCompTextContentIndexFormat);

    await this.run(schema.createCompTextContentFtsTable);

    await this.run(schema.createCompNameTable);
    await this.run(schema.createCompNameIndex);

    await this.run(schema.createCompMediaTable);
    await this.run(schema.createCompMediaIndex);

    await this.run(schema.createCompIdentifierTable);
    await this.run(schema.createCompIdentifierIndex);

    await this.run(schema.createCompDescriptionTable);
    await this.run(schema.createCompDescriptionIndex);

    await this.run(schema.createCompUrlTable);
    await this.run(schema.createCompUrlIndex);

    return "Schema initialized";
  }

  // ============ Event API ============
  private ensureSendEvent() {
    if (!this.sendEvent) {
      this.sendEvent =
        (
          window as unknown as {
            __sendEvent?: (
              event: AnyEvent,
              requestId: string,
            ) => Promise<unknown>;
          }
        ).__sendEvent || null;
    }
    if (!this.sendEvent) throw new Error("__sendEvent not initialized");
  }

  async emit(event: AnyEvent) {
    this.ensureSendEvent();
    const id = this.genId();
    try {
      const res = (await this.sendEvent!(event, id)) as Record<string, unknown>;
      this.log("event", res);
      return res;
    } catch (e) {
      this.error("emit", e);
      return { error: String(e) } as const;
    }
  }

  // // ===== Core events helpers =====
  // entityCreate(entityId: string, label: EntityLabel) {
  //   return this.emit({
  //     type: "entity.create",
  //     eventId: ulid(),
  //     entityId,
  //     label,
  //   });
  // }
  // entityDelete(entityId: string) {
  //   return this.emit({
  //     type: "entity.delete",
  //     eventId: ulid(),
  //     entityId,
  //   });
  // }
  // entitySetLabel(entityId: string, label: EntityLabel) {
  //   return this.emit({
  //     type: "entity.set_label",
  //     eventId: ulid(),
  //     entityId,
  //     label,
  //   });
  // }
  // componentUpsert<K extends ComponentName>(
  //   entityId: string,
  //   component: K,
  //   data: Partial<import("./types/components").ComponentMap[K]> &
  //     Partial<import("./types/components").BaseComponent>,
  // ) {
  //   // Strip base fields if provided
  //   const tmp = {
  //     ...(data as Partial<import("./types/components").ComponentMap[K]> &
  //       Partial<import("./types/components").BaseComponent>),
  //   };
  //   delete (tmp as Partial<import("./types/components").BaseComponent>).entity;
  //   delete (tmp as Partial<import("./types/components").BaseComponent>)
  //     .created_at;
  //   delete (tmp as Partial<import("./types/components").BaseComponent>)
  //     .updated_at;
  //   const rest = tmp as Partial<ComponentData<K>>;
  //   return this.emit({
  //     type: "component.upsert",
  //     eventId: ulid(),
  //     entityId,
  //     component,
  //     data: rest,
  //   });
  // }
  // componentRemove<K extends ComponentName>(entityId: string, component: K) {
  //   return this.emit({
  //     type: "component.remove",
  //     eventId: ulid(),
  //     entityId,
  //     component,
  //   });
  // }
  // edgeAdd<K extends import("./types/edges").EdgeLabel>(
  //   entityId: string,
  //   label: K,
  //   head: string,
  //   tail: string,
  //   payload: EdgePayload<K>,
  // ) {
  //   return this.emit({
  //     type: "edge.add",
  //     eventId: ulid(),
  //     entityId,
  //     label,
  //     head,
  //     tail,
  //     payload,
  //   });
  // }
  // edgeRemove<K extends import("./types/edges").EdgeLabel>(
  //   entityId: string,
  //   label: K,
  //   head: string,
  //   tail: string,
  // ) {
  //   return this.emit({
  //     type: "edge.remove",
  //     eventId: ulid(),
  //     entityId,
  //     label,
  //     head,
  //     tail,
  //   });
  // }
  // edgeUpdate<K extends "reaction" | "last_read" | "member">(
  //   entityId: string,
  //   label: K,
  //   head: string,
  //   tail: string,
  //   payload: EdgePayload<K>,
  // ) {
  //   return this.emit({
  //     type: "edge.update",
  //     eventId: ulid(),
  //     entityId,
  //     label,
  //     head,
  //     tail,
  //     payload,
  //   });
  // }

  // ===== Domain helpers (examples) =====
  userCreate(
    userId: EntityId,
    data?: {
      name?: CompName;
      description?: CompDescription;
      profile?: CompProfile;
      config?: CompConfig;
      avatarImageId?: EntityId;
    },
  ) {
    return this.emit({
      type: "user.create",
      eventId: ulid(),
      userId,
      ...data,
    });
  }
  userSubscribeThread(userId: EntityId, threadId: EntityId) {
    return this.emit({
      type: "user.subscribe_thread",
      eventId: ulid(),
      userId,
      threadId,
    });
  }
  spaceCreate(
    spaceId: EntityId,
    data?: {
      name?: CompName;
      description?: CompDescription;
      avatarImageId?: EntityId;
    },
  ) {
    return this.emit({
      type: "space.create",
      eventId: ulid(),
      spaceId,
      ...data,
    });
  }
  spaceAddMember(spaceId: EntityId, userId: EntityId, member: EdgeMember) {
    return this.emit({
      type: "space.add_member",
      eventId: ulid(),
      spaceId,
      userId,
      member,
    });
  }
  spaceRemoveMember(spaceId: EntityId, userId: EntityId, revocation: string) {
    return this.emit({
      type: "space.remove_member",
      eventId: ulid(),
      spaceId,
      userId,
      revocation,
    });
  }
  spaceBanUser(
    spaceId: EntityId,
    userId: EntityId,
    reason?: EdgeBan["reason"],
    bannedBy?: EdgeBan["banned_by"],
  ) {
    return this.emit({
      type: "space.ban_user",
      eventId: ulid(),
      spaceId,
      userId,
      reason,
      bannedBy,
    });
  }
  threadCreate(
    threadId: EntityId,
    data?: {
      spaceId?: EntityId;
      name?: CompName;
      description?: CompDescription;
    },
  ) {
    return this.emit({
      type: "thread.create",
      eventId: ulid(),
      threadId,
      ...data,
    });
  }
  threadPinMessage(threadId: EntityId, messageId: EntityId) {
    return this.emit({
      type: "thread.pin_message",
      eventId: ulid(),
      threadId,
      messageId,
    });
  }
  pageCreate(
    pageId: EntityId,
    data?: {
      name?: CompName;
      description?: CompDescription;
    },
  ) {
    return this.emit({
      type: "page.create",
      eventId: ulid(),
      pageId,
      ...data,
    });
  }
  threadMarkRead(userId: EntityId, threadId: EntityId, timestamp: number) {
    return this.emit({
      type: "thread.mark_read",
      eventId: ulid(),
      userId,
      threadId,
      timestamp,
    });
  }
  messagePost(
    messageId: EntityId,
    threadId: EntityId,
    authorUserId: EntityId,
    text?: CompTextContent,
    replyToMessageId?: EntityId,
    embeds?: EntityId[],
  ) {
    return this.emit({
      type: "message.post",
      eventId: ulid(),
      messageId,
      threadId,
      authorUserId,
      text,
      replyToMessageId,
      embeds,
    });
  }
  messageEdit(messageId: EntityId, text?: CompTextContent) {
    return this.emit({
      type: "message.edit",
      eventId: ulid(),
      messageId,
      text,
    });
  }
  messageDelete(messageId: EntityId) {
    return this.emit({
      type: "message.delete",
      eventId: ulid(),
      messageId,
    });
  }
  messageReact(
    messageId: EntityId,
    userId: EntityId,
    reaction: EdgeReaction["reaction"],
  ) {
    return this.emit({
      type: "message.react",
      eventId: ulid(),
      messageId,
      userId,
      reaction,
    });
  }
  messageUnreact(
    messageId: EntityId,
    userId: EntityId,
    reaction: EdgeReaction["reaction"],
  ) {
    return this.emit({
      type: "message.unreact",
      eventId: ulid(),
      messageId,
      userId,
      reaction,
    });
  }
  messageReorder(messageId: EntityId, afterMessageId: EntityId) {
    return this.emit({
      type: "message.reorder",
      eventId: ulid(),
      messageId,
      afterMessageId,
    });
  }
  uploadStart(
    uploadId: EntityId,
    mediaType: CompUpload["media_type"],
    attachToMessageId?: EntityId,
  ) {
    return this.emit({
      type: "upload.start",
      eventId: ulid(),
      uploadId,
      mediaType,
      attachToMessageId,
    });
  }
  uploadComplete(
    uploadId: EntityId,
    mediaType: CompUpload["media_type"],
    url: CompUpload["url"],
  ) {
    return this.emit({
      type: "upload.complete",
      eventId: ulid(),
      mediaType,
      uploadId,
      url,
    });
  }
  uploadFail(
    uploadId: EntityId,
    mediaType: CompUpload["media_type"],
    error: string,
  ) {
    return this.emit({
      type: "upload.fail",
      eventId: ulid(),
      mediaType,
      uploadId,
      error,
    });
  }
}
