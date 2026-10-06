/**
 * The LiveKit media lifecycle for one room's call.
 *
 * Modelled on Chatto's `voiceCall.svelte.ts`, reduced to voice-only v1. The
 * class owns the `Room`, the E2EE key provider, and the local capture, and it
 * publishes the participant list the panel renders. `livekit-client` is
 * reached only through `./livekit`, so the module graph a session that never
 * joins a call sees contains no media SDK.
 *
 * Two properties are load-bearing and are why the flow is not a straight line
 * from "user pressed Join" to `room.connect()`:
 *
 *   - **The token decides whether there is a call at all.** `getToken` returns
 *     all-null when the deployment has no LiveKit configured. That is checked
 *     *first*, before anything is recorded and before the media module is
 *     imported, so an unconfigured deployment cannot reach `livekit-client`
 *     or leave a stray join intent behind.
 *   - **A recorded join must be compensated.** The join intent is durable
 *     server-side and is what puts the user in the participant list; if the
 *     SFU connect then fails, the intent is still there. The failure path
 *     records a leave, so a failed join does not leave a phantom participant.
 *
 * All network and media access arrives through {@link VoiceCallDeps}, so the
 * class itself needs no XRPC client, no sync socket, and no browser APIs to be
 * exercised in a test.
 */

import { createE2EEWorker, loadLiveKit, type LiveKitModule } from "./livekit";
import { voicePresence } from "./presence.svelte";
import {
  connectionErrorMessage,
  mediaDeviceErrorMessage,
  redactLiveKitError,
  type VoiceErrorMessage,
} from "./voice-errors";

/** The fields of `space.roomy.voice.getToken`'s response the client needs. */
export interface VoiceTokenResponse {
  token: string | null;
  callId: string | null;
  livekitUrl: string | null;
  e2eeKey: string | null;
}

/** Everything the media path reaches outside itself. */
export interface VoiceCallDeps {
  getToken(roomId: string): Promise<VoiceTokenResponse>;
  joinCall(roomId: string): Promise<void>;
  leaveCall(roomId: string): Promise<void>;
  sendVoiceState(roomId: string, muted: boolean, deafened: boolean): void;
  reportError(err: VoiceErrorMessage): void;
}

/** One participant as the panel renders them. */
export interface VoiceCallParticipant {
  did: string;
  name: string | null;
  muted: boolean;
  speaking: boolean;
  audioLevel: number;
  local: boolean;
}

/**
 * How often the audio levels are sampled.
 *
 * Levels are read off the participant objects and are not events, so the
 * panel renders whatever the last sample saw. 60 ms keeps the speaking ring
 * responsive without running a rAF loop per participant.
 */
const AUDIO_LEVEL_SAMPLE_MS = 60;

/**
 * Whether a token response describes a call the client can actually join.
 *
 * The appserver returns every field null rather than an error when LiveKit is
 * unconfigured, so this is the client-side half of that contract: a partial
 * response is a broken deployment, not a joinable call.
 */
export function isJoinable(res: VoiceTokenResponse | null | undefined): boolean {
  return (
    res != null &&
    typeof res.token === "string" &&
    res.token.length > 0 &&
    typeof res.callId === "string" &&
    res.callId.length > 0 &&
    typeof res.livekitUrl === "string" &&
    res.livekitUrl.length > 0 &&
    typeof res.e2eeKey === "string" &&
    res.e2eeKey.length > 0
  );
}

export class VoiceCallState {
  #deps: VoiceCallDeps;

  /** The room whose call this session is in, or null when not in a call. */
  roomId = $state<string | null>(null);
  /** The call generation, from the token response. */
  callId = $state<string | null>(null);
  /** True once the SFU connection is established. */
  connected = $state(false);
  /** True from the moment a join is accepted until it settles either way. */
  connecting = $state(false);
  /** The local participant's microphone state. */
  muted = $state(false);
  /** The local participant's deafened state (remote audio muted). */
  deafened = $state(false);
  /**
   * True when `getToken` reported no LiveKit configuration. The UI renders no
   * call affordances in that state.
   */
  unavailable = $state(false);

  /** Participants from the SFU, keyed by DID. Only non-empty while joined. */
  #participants = $state(new Map<string, VoiceCallParticipant>());

  #room: InstanceType<LiveKitModule["Room"]> | null = null;
  #livekit: LiveKitModule | null = null;
  /** Local media elements the remote tracks were attached to. */
  #audioElements = new Map<string, HTMLMediaElement>();
  #levelTimer: ReturnType<typeof setInterval> | null = null;

  #joinInFlight: Promise<void> | null = null;
  #leaveInFlight: Promise<void> | null = null;
  /**
   * A leave arrived while a join was still in flight. The join runs to
   * completion (there is nothing to disconnect yet) and then leaves
   * immediately — the user's last intent wins, and no second connect races
   * the first.
   */
  #leaveRequested = false;

  constructor(deps: VoiceCallDeps) {
    this.#deps = deps;
  }

  /** The participants the panel renders, local participant first. */
  participants(): VoiceCallParticipant[] {
    const all = [...this.#participants.values()];
    return all.sort((a, b) => Number(b.local) - Number(a.local));
  }

  /** Who is speaking, for the panel's indicators. */
  speakingDids(): string[] {
    return [...this.#participants.values()].filter((p) => p.speaking).map((p) => p.did);
  }

  /**
   * Join `roomId`'s call.
   *
   * Concurrent calls for the same join share one attempt: the join is
   * triggered by a button that a user can press twice, and two `room.connect`
   * calls would race for the same room.
   */
  async join(roomId: string): Promise<void> {
    if (this.connected && this.roomId === roomId) return;
    if (this.#joinInFlight) return this.#joinInFlight;

    this.#leaveRequested = false;
    const attempt = this.#performJoin(roomId);
    this.#joinInFlight = attempt;
    try {
      await attempt;
    } finally {
      if (this.#joinInFlight === attempt) this.#joinInFlight = null;
    }
    if (this.#leaveRequested) await this.leave();
  }

  /**
   * Leave the current call. Concurrent calls share one attempt, and a leave
   * during a join is deferred to the end of that join (see
   * {@link #leaveRequested}).
   */
  async leave(): Promise<void> {
    if (this.#leaveInFlight) return this.#leaveInFlight;
    if (!this.connected || !this.#room) {
      // Mid-join: there is no room to disconnect yet, so record the intent and
      // let `join` act on it once it settles.
      if (this.#joinInFlight) this.#leaveRequested = true;
      return;
    }

    const attempt = this.#performLeave();
    this.#leaveInFlight = attempt;
    try {
      await attempt;
    } finally {
      if (this.#leaveInFlight === attempt) this.#leaveInFlight = null;
    }
  }

  /** Toggle the local microphone, publishing the new state to the room. */
  async setMuted(muted: boolean): Promise<void> {
    if (muted === this.muted) return;
    const room = this.#room;
    if (room && this.connected) {
      try {
        await room.localParticipant.setMicrophoneEnabled(!muted, this.#audioCaptureOptions());
      } catch (err) {
        this.#deps.reportError(mediaDeviceErrorMessage("microphone", err, "switching"));
        return;
      }
      this.#syncLocalParticipant();
    }
    this.muted = muted;
    if (this.roomId) this.#deps.sendVoiceState(this.roomId, this.muted, this.deafened);
  }

  /**
   * Deafen: stop playing remote audio without leaving the call. Undeafening
   * restores playback; deafening also mutes the microphone, because
   * deafening is "I am not participating right now".
   */
  setDeafened(deafened: boolean): void {
    if (deafened === this.deafened) return;
    this.deafened = deafened;
    for (const el of this.#audioElements.values()) el.muted = deafened;
    this.#syncLocalParticipant();
    if (this.roomId) this.#deps.sendVoiceState(this.roomId, this.muted, this.deafened);
  }

  /** Release all media and record a leave. Called when the panel unmounts. */
  dispose(): void {
    void this.leave();
  }

  // ── Join / leave internals ───────────────────────────────────────────────

  async #performJoin(roomId: string): Promise<void> {
    if (this.connected) await this.leave();
    this.connecting = true;

    let joinIntentRecorded = false;
    let ownedRoom: InstanceType<LiveKitModule["Room"]> | null = null;

    try {
      // The token response is the availability check. Nothing is recorded and
      // no media module is imported until it says there is a call to join.
      const token = await this.#deps.getToken(roomId);
      if (!isJoinable(token)) {
        this.unavailable = true;
        return;
      }
      this.unavailable = false;

      // The join intent is durable and is what makes the user visible to
      // others before their media is up. It is recorded before connecting so a
      // slow SFU does not hide an active participant.
      await this.#deps.joinCall(roomId);
      joinIntentRecorded = true;

      const livekit = await loadLiveKit();
      this.#livekit = livekit;
      const { Room, ExternalE2EEKeyProvider, AudioPresets } = livekit;

      const keyProvider = new ExternalE2EEKeyProvider();
      const worker = await createE2EEWorker();

      const room = new Room({
        encryption: { keyProvider, worker },
        audioCaptureDefaults: this.#audioCaptureOptions(),
        publishDefaults: {
          audioPreset: AudioPresets.speech,
          forceStereo: false,
          dtx: true,
          red: true,
        },
        adaptiveStream: true,
        dynacast: true,
        disconnectOnPageLeave: true,
      });
      ownedRoom = room;
      this.#room = room;
      this.#subscribeRoomEvents(room);
      this.roomId = roomId;
      this.callId = token.callId;

      await keyProvider.setKey(token.e2eeKey!);
      await room.setE2EEEnabled(true);
      await room.connect(token.livekitUrl!, token.token!);

      // A dispose (or a replacement join) during the await above must not be
      // overwritten by this attempt's result.
      if (this.#room !== room) {
        await room.disconnect();
        return;
      }

      this.connected = true;
      this.muted = false;
      this.#refreshParticipants();
      this.#startLevelSampling();

      // Capture starts after connect so a microphone failure is reported as
      // "you are in the call, muted" rather than as a failed join — the user
      // is audible only if the browser lets them be.
      try {
        await room.localParticipant.setMicrophoneEnabled(true, this.#audioCaptureOptions());
        this.#syncLocalParticipant();
      } catch (err) {
        this.muted = true;
        this.#deps.reportError(mediaDeviceErrorMessage("microphone", err, "joining"));
      }
      if (this.roomId) this.#deps.sendVoiceState(this.roomId, this.muted, this.deafened);

      if (this.#room !== room) {
        await room.localParticipant.setMicrophoneEnabled(false);
        await room.disconnect();
        return;
      }
      this.#refreshParticipants();
    } catch (err) {
      // Compensating leave: the join intent is durable, so a failed connect
      // must retract it or the participant list keeps a user who never
      // arrived.
      if (ownedRoom && this.#room !== ownedRoom) {
        await ownedRoom.disconnect();
        return;
      }
      // Redacted: the connect URL can carry the access token.
      console.error(`[voice] ${redactLiveKitError(err)}`);
      this.#deps.reportError(connectionErrorMessage(err));
      if (joinIntentRecorded) {
        await this.#deps.leaveCall(roomId).catch(() => {});
      }
      this.#teardown();
      throw err;
    } finally {
      this.connecting = false;
    }
  }

  async #performLeave(): Promise<void> {
    const roomId = this.roomId;
    const room = this.#room;
    this.#teardown();
    if (room) await room.disconnect();
    if (roomId) {
      await this.#deps.leaveCall(roomId).catch(() => {});
      voicePresence.clearRoom(roomId);
    }
  }

  /** Release every local resource. Idempotent. */
  #teardown(): void {
    this.#stopLevelSampling();
    for (const el of this.#audioElements.values()) el.remove();
    this.#audioElements.clear();
    this.#participants = new Map();
    this.#room = null;
    this.#livekit = null;
    this.roomId = null;
    this.callId = null;
    this.connected = false;
    this.muted = false;
    this.deafened = false;
  }

  // ── Media ────────────────────────────────────────────────────────────────

  /**
   * Mono speech capture. Channel count is pinned to 1 because the preset is
   * speech (a stereo stream doubles the payload for no intelligibility gain),
   * and automatic gain control is left off so the browser does not ride the
   * level of a room where someone is breathing.
   */
  #audioCaptureOptions() {
    return {
      channelCount: { ideal: 1 },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
    };
  }

  #subscribeRoomEvents(room: InstanceType<LiveKitModule["Room"]>): void {
    const { RoomEvent } = this.#livekit!;

    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== "audio") return;
      const el = track.attach();
      el.muted = this.deafened;
      el.style.display = "none";
      document.body.appendChild(el);
      this.#audioElements.set(track.sid ?? String(this.#audioElements.size), el);
    });

    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((el) => el.remove());
      if (track.sid) {
        this.#audioElements.delete(track.sid);
      }
    });

    const refresh = () => this.#refreshParticipants();
    room.on(RoomEvent.ParticipantConnected, refresh);
    room.on(RoomEvent.ParticipantDisconnected, refresh);
    room.on(RoomEvent.TrackMuted, refresh);
    room.on(RoomEvent.TrackUnmuted, refresh);
    room.on(RoomEvent.ActiveSpeakersChanged, refresh);
    room.on(RoomEvent.LocalTrackPublished, refresh);

    room.on(RoomEvent.Disconnected, () => {
      if (this.#room !== room) return;
      this.#teardown();
    });
  }

  #refreshParticipants(): void {
    const room = this.#room;
    if (!room) return;
    const next = new Map<string, VoiceCallParticipant>();

    const local = room.localParticipant;
    next.set(local.identity, {
      did: local.identity,
      name: local.name ?? null,
      muted: !local.isMicrophoneEnabled,
      speaking: local.isSpeaking,
      audioLevel: local.audioLevel,
      local: true,
    });

    for (const participant of room.remoteParticipants.values()) {
      next.set(participant.identity, {
        did: participant.identity,
        name: participant.name ?? null,
        muted: !participant.isMicrophoneEnabled,
        speaking: participant.isSpeaking,
        audioLevel: participant.audioLevel,
        local: false,
      });
    }

    this.#participants = next;
  }

  /** Keep the local row's mic state in step with the track the SFU sees. */
  #syncLocalParticipant(): void {
    const room = this.#room;
    if (!room) return;
    const did = room.localParticipant.identity;
    const current = this.#participants.get(did);
    if (!current) return;
    const next = new Map(this.#participants);
    next.set(did, { ...current, muted: !room.localParticipant.isMicrophoneEnabled });
    this.#participants = next;
  }

  #startLevelSampling(): void {
    if (this.#levelTimer !== null) return;
    this.#levelTimer = setInterval(() => {
      const room = this.#room;
      if (!room) return;
      const next = new Map(this.#participants);
      let changed = false;
      for (const [did, p] of next) {
        const source = p.local
          ? room.localParticipant
          : room.getParticipantByIdentity(did);
        if (!source) continue;
        if (source.audioLevel === p.audioLevel && source.isSpeaking === p.speaking) continue;
        next.set(did, { ...p, audioLevel: source.audioLevel, speaking: source.isSpeaking });
        changed = true;
      }
      if (changed) this.#participants = next;
    }, AUDIO_LEVEL_SAMPLE_MS);
  }

  #stopLevelSampling(): void {
    if (this.#levelTimer === null) return;
    clearInterval(this.#levelTimer);
    this.#levelTimer = null;
  }
}

