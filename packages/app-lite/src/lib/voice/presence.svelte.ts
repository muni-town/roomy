/**
 * Who is in which call, as the sync socket reports it.
 *
 * Voice presence is ephemeral: the appserver never persists mute/deafen, and
 * a `#voicePresenceDiff` carries only the transition. So this holds the
 * client's view of a room's call — the call generation, the participant set,
 * and each participant's flags — and patches it from frames as they arrive.
 *
 * A transition the store cannot apply is not guessed at. A frame naming a
 * call generation the store has never seen carries no participant list with
 * it, so the store marks the room as needing a refetch instead of inventing
 * one: the `getParticipants` projection is the source of truth and the store
 * is only an optimisation over re-reading it.
 *
 * Nothing here imports `livekit-client` or the SDK: the frame handler is a
 * plain function of the frame body, which is what makes the whole presence
 * path testable without a socket.
 */

export interface VoiceParticipantState {
  did: string;
  muted: boolean;
  deafened: boolean;
}

export interface VoiceRoomCall {
  callId: string;
  participants: Map<string, VoiceParticipantState>;
}

/** What a frame asked the caller to do beyond patching. */
export interface VoicePresenceOutcome {
  /**
   * The store's view of this room is incomplete — either the frame named a
   * call it had never seen, or it named one that replaced the call it held.
   * The caller must re-read `getParticipants` rather than trust the patch.
   */
  needsRefetch: boolean;
  /** True when the room's participant set changed (added or removed). */
  participantsChanged: boolean;
}

const NO_CHANGE: VoicePresenceOutcome = {
  needsRefetch: false,
  participantsChanged: false,
};

/**
 * The client's live view of call presence.
 *
 * Reads are reactive: the class holds `$state`, so a Svelte component that
 * derives from `participants()` or `activeCallIds()` re-renders when a frame
 * lands. Writes come from exactly two places — the sync frame handler and the
 * local participant's own mute/deafen — so the state has one shape regardless
 * of where a change originated.
 */
export class VoicePresenceStore {
  #rooms = $state(new Map<string, VoiceRoomCall>());

  /**
   * Apply a `#voicePresenceDiff`.
   *
   * The generation check is what keeps a late frame from a previous call from
   * resurrecting it: a `callEnded` or `leave` naming a call we no longer hold
   * is dropped, and a `join` naming a different generation replaces the room's
   * whole entry — the participants we held belonged to the call that ended.
   */
  applyPresence(
    roomId: string,
    callId: string,
    op: "join" | "leave" | "callEnded",
    did?: string,
  ): VoicePresenceOutcome {
    const current = this.#rooms.get(roomId);

    if (op === "callEnded") {
      if (!current || current.callId !== callId) return NO_CHANGE;
      const next = new Map(this.#rooms);
      next.delete(roomId);
      this.#rooms = next;
      return { needsRefetch: false, participantsChanged: true };
    }

    if (op === "leave") {
      if (!current || current.callId !== callId) return NO_CHANGE;
      if (!did || !current.participants.has(did)) return NO_CHANGE;
      const participants = new Map(current.participants);
      participants.delete(did);
      const next = new Map(this.#rooms);
      next.set(roomId, { callId, participants });
      this.#rooms = next;
      return { needsRefetch: false, participantsChanged: true };
    }

    // A join for a generation we do not hold: the room either had no call or
    // had a different one. Either way the participant list we would patch has
    // nothing to do with this call, so the caller re-reads it.
    const isNewGeneration = !current || current.callId !== callId;
    if (isNewGeneration) {
      const participants = new Map<string, VoiceParticipantState>();
      if (did) {
        participants.set(did, {
          did,
          muted: false,
          deafened: false,
        });
      }
      const next = new Map(this.#rooms);
      next.set(roomId, { callId, participants });
      this.#rooms = next;
      return { needsRefetch: true, participantsChanged: true };
    }

    if (!did || current.participants.has(did)) return NO_CHANGE;
    const participants = new Map(current.participants);
    participants.set(did, { did, muted: false, deafened: false });
    const next = new Map(this.#rooms);
    next.set(roomId, { callId, participants });
    this.#rooms = next;
    return { needsRefetch: false, participantsChanged: true };
  }

  /**
   * Apply a `#voiceStateDiff`. A flag change for someone not in the call is
   * dropped: the frame is delivered to every subscriber of the room, and a
   * participant who left a moment ago is not in this client's list.
   */
  applyState(
    roomId: string,
    did: string,
    muted: boolean,
    deafened: boolean,
  ): boolean {
    const current = this.#rooms.get(roomId);
    const participant = current?.participants.get(did);
    if (!current || !participant) return false;
    if (participant.muted === muted && participant.deafened === deafened) {
      return false;
    }
    const participants = new Map(current.participants);
    participants.set(did, { did, muted, deafened });
    const next = new Map(this.#rooms);
    next.set(roomId, { callId: current.callId, participants });
    this.#rooms = next;
    return true;
  }

  /**
   * Replace a room's view with a `getParticipants` snapshot — the authority
   * the diff stream is only an optimisation over. Called on subscribe, on a
   * reconnect, and whenever a frame asked for a refetch.
   */
  applySnapshot(
    roomId: string,
    callId: string | null,
    participants: ReadonlyArray<{ did: string }>,
  ): void {
    const next = new Map(this.#rooms);
    if (!callId) {
      next.delete(roomId);
    } else {
      const held = next.get(roomId);
      const merged = new Map<string, VoiceParticipantState>();
      for (const p of participants) {
        // Keep the flags we were told about: a snapshot carries presence, not
        // mute state, which is ephemeral and arrives on its own frames.
        merged.set(p.did, held?.participants.get(p.did) ?? {
          did: p.did,
          muted: false,
          deafened: false,
        });
      }
      next.set(roomId, { callId, participants: merged });
    }
    this.#rooms = next;
  }

  /** Forget a room entirely (left the room, or the call ended). */
  clearRoom(roomId: string): void {
    if (!this.#rooms.has(roomId)) return;
    const next = new Map(this.#rooms);
    next.delete(roomId);
    this.#rooms = next;
  }

  /** Everything currently in the room's call, in insertion order. */
  participants(roomId: string): VoiceParticipantState[] {
    return [...(this.#rooms.get(roomId)?.participants.values() ?? [])];
  }

  /** The call generation the room is on, or null when it has no call. */
  callId(roomId: string): string | null {
    return this.#rooms.get(roomId)?.callId ?? null;
  }

  /** Whether the room has a live call — the sidebar's pulse condition. */
  hasActiveCall(roomId: string): boolean {
    return this.#rooms.has(roomId);
  }

  /** Every room with a live call, for the space sidebar. */
  activeRoomIds(): string[] {
    return [...this.#rooms.keys()];
  }
}

/**
 * The process-wide presence store.
 *
 * One store, not one per component: the sync socket is a single connection
 * feeding one frame stream, and the sidebar, the room panel, and the call
 * state all read the same presence. Keeping it a module singleton is what lets
 * the frame handler stay a plain function with nowhere to route to.
 */
export const voicePresence = new VoicePresenceStore();
