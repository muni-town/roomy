import { beforeEach, describe, expect, it, vi } from "vitest";

import { VoiceCallState, isJoinable } from "./VoiceCallState.svelte";
import type { VoiceCallDeps, VoiceTokenResponse } from "./VoiceCallState.svelte";
import { VoicePresenceStore } from "./presence.svelte";

/** The token response an unconfigured deployment returns: every field null. */
const UNCONFIGURED: VoiceTokenResponse = {
  token: null,
  callId: null,
  livekitUrl: null,
  e2eeKey: null,
};

/** A joinable token response, as a configured appserver mints it. */
function configuredToken(callId = "call-1"): VoiceTokenResponse {
  return {
    token: "jwt-token",
    callId,
    livekitUrl: "wss://livekit.test",
    e2eeKey: "e2ee-passphrase",
  };
}

interface FakeParticipant {
  identity: string;
  name?: string;
  isMicrophoneEnabled: boolean;
  isSpeaking: boolean;
  audioLevel: number;
  setMicrophoneEnabled: ReturnType<typeof vi.fn>;
}

function fakeParticipant(identity: string, opts: Partial<FakeParticipant> = {}): FakeParticipant {
  const participant: FakeParticipant = {
    identity,
    isMicrophoneEnabled: false,
    isSpeaking: false,
    audioLevel: 0,
    setMicrophoneEnabled: vi.fn(async (enabled: boolean) => {
      participant.isMicrophoneEnabled = enabled;
    }),
    ...opts,
  };
  return participant;
}

/**
 * A controllable stand-in for `livekit-client`'s `Room`.
 *
 * The gates (`connectBehaviour`, `micBehaviour`) let a test choose whether a
 * connect or a microphone capture fails, which is how the compensating-leave
 * and joined-muted paths are exercised without a browser or an SFU.
 */
class FakeRoom {
  static instances: FakeRoom[] = [];
  static connectBehaviour: "resolve" | "reject" = "resolve";
  static micBehaviour: "resolve" | "reject" = "resolve";

  localParticipant: FakeParticipant;
  remoteParticipants = new Map<string, FakeParticipant>();
  #handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  setE2EEEnabled = vi.fn(async () => {});
  disconnect = vi.fn(async () => {});
  connect = vi.fn(async () => {
    if (FakeRoom.connectBehaviour === "reject") throw new Error("signal connection failed");
  });
  getParticipantByIdentity = (identity: string) => this.remoteParticipants.get(identity);

  constructor(
    public options: unknown,
    private audioCaptureDefaults: unknown,
  ) {
    this.localParticipant = fakeParticipant("did:plc:me", {
      setMicrophoneEnabled: vi.fn(async (enabled: boolean) => {
        if (enabled && FakeRoom.micBehaviour === "reject") {
          const err = new Error("Permission denied");
          err.name = "NotAllowedError";
          throw err;
        }
        this.localParticipant.isMicrophoneEnabled = enabled;
      }),
    });
    FakeRoom.instances.push(this);
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    const list = this.#handlers.get(event) ?? [];
    list.push(handler);
    this.#handlers.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.#handlers.get(event) ?? []) handler(...args);
  }

  get audioCapture(): unknown {
    return this.audioCaptureDefaults;
  }
}

class FakeKeyProvider {
  setKey = vi.fn(async () => {});
}

const ROOM_EVENTS = {
  TrackSubscribed: "trackSubscribed",
  TrackUnsubscribed: "trackUnsubscribed",
  ParticipantConnected: "participantConnected",
  ParticipantDisconnected: "participantDisconnected",
  TrackMuted: "trackMuted",
  TrackUnmuted: "trackUnmuted",
  ActiveSpeakersChanged: "activeSpeakersChanged",
  LocalTrackPublished: "localTrackPublished",
  Disconnected: "disconnected",
};

vi.mock("./livekit", () => ({
  loadLiveKit: async () => ({
    Room: FakeRoom,
    ExternalE2EEKeyProvider: FakeKeyProvider,
    AudioPresets: { speech: { maxBitrate: 24_000 } },
    RoomEvent: ROOM_EVENTS,
  }),
  createE2EEWorker: async () => ({ postMessage: vi.fn() }) as unknown as Worker,
}));

interface Harness {
  state: VoiceCallState;
  deps: {
    getToken: ReturnType<typeof vi.fn>;
    joinCall: ReturnType<typeof vi.fn>;
    leaveCall: ReturnType<typeof vi.fn>;
    sendVoiceState: ReturnType<typeof vi.fn>;
    reportError: ReturnType<typeof vi.fn>;
  };
}

function makeHarness(token: VoiceTokenResponse = configuredToken()): Harness {
  const deps = {
    getToken: vi.fn(async () => token),
    joinCall: vi.fn(async () => {}),
    leaveCall: vi.fn(async () => {}),
    sendVoiceState: vi.fn(),
    reportError: vi.fn(),
  };
  return { state: new VoiceCallState(deps as VoiceCallDeps), deps };
}

beforeEach(() => {
  FakeRoom.instances = [];
  FakeRoom.connectBehaviour = "resolve";
  FakeRoom.micBehaviour = "resolve";
  vi.clearAllMocks();
});

describe("isJoinable", () => {
  it("rejects the all-null response an unconfigured deployment returns", () => {
    expect(isJoinable(UNCONFIGURED)).toBe(false);
    expect(isJoinable(null)).toBe(false);
    expect(isJoinable(undefined)).toBe(false);
  });

  it("rejects a partial response rather than treating it as joinable", () => {
    expect(isJoinable({ ...configuredToken(), e2eeKey: null })).toBe(false);
    expect(isJoinable({ ...configuredToken(), livekitUrl: "" })).toBe(false);
    expect(isJoinable({ ...configuredToken(), callId: null })).toBe(false);
    expect(isJoinable({ ...configuredToken(), token: null })).toBe(false);
  });

  it("accepts a fully populated token response", () => {
    expect(isJoinable(configuredToken())).toBe(true);
  });
});

describe("VoiceCallState — degraded path", () => {
  it("marks the call unavailable and imports no media module", async () => {
    const { state, deps } = makeHarness(UNCONFIGURED);

    await state.join("room-1");

    expect(state.unavailable).toBe(true);
    expect(state.connected).toBe(false);
    expect(state.roomId).toBeNull();
    // No join intent was recorded, so nothing has to be compensated, and no
    // livekit-client module was loaded (FakeRoom is only constructed by the
    // mocked loader when the join actually proceeds).
    expect(deps.joinCall).not.toHaveBeenCalled();
    expect(FakeRoom.instances).toHaveLength(0);
  });

  it("does not report a device or connection error for an unconfigured deployment", async () => {
    const { state, deps } = makeHarness(UNCONFIGURED);
    await state.join("room-1");
    expect(deps.reportError).not.toHaveBeenCalled();
  });
});

describe("VoiceCallState — join", () => {
  it("records the join intent before connecting and publishes state after", async () => {
    const { state, deps } = makeHarness();
    const order: string[] = [];
    deps.joinCall.mockImplementation(async () => {
      order.push("joinCall");
    });
    FakeRoom.prototype.connect = undefined as never;
    const originalConnect = FakeRoom.instances;

    await state.join("room-1");

    expect(order).toContain("joinCall");
    expect(state.connected).toBe(true);
    expect(state.roomId).toBe("room-1");
    expect(state.callId).toBe("call-1");
    expect(originalConnect).toHaveLength(1);
    // The local participant's initial state reaches the room, so an observer
    // sees a muted/unmuted row without waiting for a flag change.
    expect(deps.sendVoiceState).toHaveBeenCalledWith("room-1", false, false);
  });

  it("coalesces concurrent joins into one attempt", async () => {
    const { state, deps } = makeHarness();

    await Promise.all([state.join("room-1"), state.join("room-1"), state.join("room-1")]);

    expect(deps.getToken).toHaveBeenCalledTimes(1);
    expect(deps.joinCall).toHaveBeenCalledTimes(1);
    expect(FakeRoom.instances).toHaveLength(1);
  });

  it("is a no-op when already connected to the same room", async () => {
    const { state, deps } = makeHarness();
    await state.join("room-1");
    await state.join("room-1");

    expect(deps.joinCall).toHaveBeenCalledTimes(1);
    expect(FakeRoom.instances).toHaveLength(1);
  });

  it("configures mono speech capture with DTX and RED", async () => {
    const { state } = makeHarness();
    await state.join("room-1");

    const room = FakeRoom.instances[0]!;
    const options = room.options as {
      publishDefaults: { audioPreset: unknown; dtx: boolean; red: boolean };
      audioCaptureDefaults: { channelCount: { ideal: number }; echoCancellation: boolean; noiseSuppression: boolean };
    };
    expect(options.publishDefaults.dtx).toBe(true);
    expect(options.publishDefaults.red).toBe(true);
    expect(options.audioCaptureDefaults.channelCount).toEqual({ ideal: 1 });
    expect(options.audioCaptureDefaults.echoCancellation).toBe(true);
    expect(options.audioCaptureDefaults.noiseSuppression).toBe(true);
  });

  it("enables E2EE before connecting", async () => {
    const { state } = makeHarness();
    await state.join("room-1");
    const room = FakeRoom.instances[0]!;
    expect(room.setE2EEEnabled).toHaveBeenCalledWith(true);
    // `connect` is called after both the key is set and E2EE is enabled; the
    // mock records the ordering through the shared invocation order.
    const e2eeOrder = room.setE2EEEnabled.mock.invocationCallOrder[0]!;
    const connectOrder = room.connect.mock.invocationCallOrder[0]!;
    expect(e2eeOrder).toBeLessThan(connectOrder);
  });

  it("joins muted with an actionable message when the microphone is blocked", async () => {
    FakeRoom.micBehaviour = "reject";
    const { state, deps } = makeHarness();

    await state.join("room-1");

    expect(state.connected).toBe(true);
    expect(state.muted).toBe(true);
    expect(deps.reportError).toHaveBeenCalledTimes(1);
    const message = deps.reportError.mock.calls[0]![0] as { title: string; description: string };
    expect(message.title).toBe("Joined muted");
    expect(message.description).toMatch(/blocked microphone access/i);
  });
});

describe("VoiceCallState — compensating leave", () => {
  it("records a leave when the SFU connect fails after the join intent", async () => {
    FakeRoom.connectBehaviour = "reject";
    const { state, deps } = makeHarness();

    await expect(state.join("room-1")).rejects.toThrow();

    expect(deps.joinCall).toHaveBeenCalledWith("room-1");
    expect(deps.leaveCall).toHaveBeenCalledWith("room-1");
    expect(state.connected).toBe(false);
    expect(state.roomId).toBeNull();
    expect(deps.reportError).toHaveBeenCalledTimes(1);
  });

  it("does not record a leave when the token fetch fails before any intent", async () => {
    const { state, deps } = makeHarness();
    deps.getToken.mockRejectedValue(new Error("network down"));

    await expect(state.join("room-1")).rejects.toThrow("network down");

    expect(deps.joinCall).not.toHaveBeenCalled();
    expect(deps.leaveCall).not.toHaveBeenCalled();
  });
});

describe("VoiceCallState — leave", () => {
  it("records the leave and releases the room", async () => {
    const { state, deps } = makeHarness();
    await state.join("room-1");
    const room = FakeRoom.instances[0]!;

    await state.leave();

    expect(deps.leaveCall).toHaveBeenCalledWith("room-1");
    expect(room.disconnect).toHaveBeenCalled();
    expect(state.connected).toBe(false);
    expect(state.roomId).toBeNull();
    expect(state.participants()).toHaveLength(0);
  });

  it("coalesces concurrent leaves", async () => {
    const { state, deps } = makeHarness();
    await state.join("room-1");
    await Promise.all([state.leave(), state.leave(), state.leave()]);
    expect(deps.leaveCall).toHaveBeenCalledTimes(1);
  });

  it("leaves after a join in flight settles, without racing the connect", async () => {
    const { state, deps } = makeHarness();

    const join = state.join("room-1");
    const leave = state.leave();
    await join;
    await leave;

    expect(state.connected).toBe(false);
    expect(deps.leaveCall).toHaveBeenCalledWith("room-1");
    // The connect ran exactly once — the deferred leave did not start a
    // second one.
    expect(FakeRoom.instances).toHaveLength(1);
  });

  it("is a no-op when not in a call", async () => {
    const { state, deps } = makeHarness();
    await state.leave();
    expect(deps.leaveCall).not.toHaveBeenCalled();
  });
});

describe("VoiceCallState — mute and deafen", () => {
  it("publishes the mute change to the room", async () => {
    const { state, deps } = makeHarness();
    await state.join("room-1");
    deps.sendVoiceState.mockClear();

    await state.setMuted(true);

    expect(state.muted).toBe(true);
    expect(deps.sendVoiceState).toHaveBeenCalledWith("room-1", true, false);
  });

  it("keeps the muted state when an unmute is refused by the device", async () => {
    // Join with capture blocked, so the session starts muted; the unmute that
    // follows is the operation the device refuses.
    FakeRoom.micBehaviour = "reject";
    const { state, deps } = makeHarness();
    await state.join("room-1");
    const room = FakeRoom.instances[0]!;
    deps.sendVoiceState.mockClear();
    deps.reportError.mockClear();
    expect(state.muted).toBe(true);

    await state.setMuted(false);

    // The state did not flip to unmuted, and the room was not told otherwise.
    expect(state.muted).toBe(true);
    expect(deps.sendVoiceState).not.toHaveBeenCalled();
    expect(room.localParticipant.isMicrophoneEnabled).toBe(false);
    expect(deps.reportError).toHaveBeenCalledTimes(1);
  });

  it("deafens by muting remote audio and publishes the flag", async () => {
    const { state, deps } = makeHarness();
    await state.join("room-1");
    deps.sendVoiceState.mockClear();

    state.setDeafened(true);

    expect(state.deafened).toBe(true);
    expect(deps.sendVoiceState).toHaveBeenCalledWith("room-1", false, true);
  });
});

describe("VoiceCallState — participants", () => {
  it("lists the local participant first, then remotes", async () => {
    const { state } = makeHarness();
    await state.join("room-1");
    const room = FakeRoom.instances[0]!;
    room.remoteParticipants.set(
      "did:plc:them",
      fakeParticipant("did:plc:them", { name: "Them" }),
    );
    room.emit(ROOM_EVENTS.ParticipantConnected);

    const participants = state.participants();
    expect(participants.map((p) => p.did)).toEqual(["did:plc:me", "did:plc:them"]);
    expect(participants[0]!.local).toBe(true);
    expect(participants[1]!.name).toBe("Them");
  });

  it("drops a participant when the SFU says they disconnected", async () => {
    const { state } = makeHarness();
    await state.join("room-1");
    const room = FakeRoom.instances[0]!;
    room.remoteParticipants.set("did:plc:them", fakeParticipant("did:plc:them"));
    room.emit(ROOM_EVENTS.ParticipantConnected);
    expect(state.participants()).toHaveLength(2);

    room.remoteParticipants.delete("did:plc:them");
    room.emit(ROOM_EVENTS.ParticipantDisconnected);

    expect(state.participants().map((p) => p.did)).toEqual(["did:plc:me"]);
  });
});

describe("VoicePresenceStore", () => {
  let store: VoicePresenceStore;

  beforeEach(() => {
    store = new VoicePresenceStore();
  });

  it("treats a join for an unknown generation as needing a refetch", () => {
    const outcome = store.applyPresence("room-1", "call-1", "join", "did:plc:a");

    expect(outcome.needsRefetch).toBe(true);
    expect(store.callId("room-1")).toBe("call-1");
    expect(store.participants("room-1").map((p) => p.did)).toEqual(["did:plc:a"]);
  });

  it("patches a join for a generation it already holds without refetching", () => {
    store.applySnapshot("room-1", "call-1", [{ did: "did:plc:a" }]);

    const outcome = store.applyPresence("room-1", "call-1", "join", "did:plc:b");

    expect(outcome.needsRefetch).toBe(false);
    expect(store.participants("room-1").map((p) => p.did)).toEqual(["did:plc:a", "did:plc:b"]);
  });

  it("removes a participant on leave", () => {
    store.applySnapshot("room-1", "call-1", [{ did: "did:plc:a" }, { did: "did:plc:b" }]);

    store.applyPresence("room-1", "call-1", "leave", "did:plc:a");

    expect(store.participants("room-1").map((p) => p.did)).toEqual(["did:plc:b"]);
  });

  it("ignores a leave naming a superseded generation", () => {
    store.applySnapshot("room-1", "call-2", [{ did: "did:plc:a" }]);

    const outcome = store.applyPresence("room-1", "call-1", "leave", "did:plc:a");

    expect(outcome.participantsChanged).toBe(false);
    expect(store.participants("room-1")).toHaveLength(1);
  });

  it("replaces the room's entry when a new generation starts", () => {
    store.applySnapshot("room-1", "call-1", [{ did: "did:plc:a" }]);

    const outcome = store.applyPresence("room-1", "call-2", "join", "did:plc:b");

    expect(outcome.needsRefetch).toBe(true);
    expect(store.callId("room-1")).toBe("call-2");
    expect(store.participants("room-1").map((p) => p.did)).toEqual(["did:plc:b"]);
  });

  it("clears the room on callEnded and reports the change", () => {
    store.applySnapshot("room-1", "call-1", [{ did: "did:plc:a" }]);

    const outcome = store.applyPresence("room-1", "call-1", "callEnded");

    expect(outcome.participantsChanged).toBe(true);
    expect(store.hasActiveCall("room-1")).toBe(false);
    expect(store.activeRoomIds()).toEqual([]);
  });

  it("ignores callEnded for a generation it does not hold", () => {
    store.applySnapshot("room-1", "call-2", [{ did: "did:plc:a" }]);

    const outcome = store.applyPresence("room-1", "call-1", "callEnded");

    expect(outcome.participantsChanged).toBe(false);
    expect(store.hasActiveCall("room-1")).toBe(true);
  });

  it("applies a mute/deafen change to a participant it holds", () => {
    store.applySnapshot("room-1", "call-1", [{ did: "did:plc:a" }]);

    expect(store.applyState("room-1", "did:plc:a", true, false)).toBe(true);
    expect(store.participants("room-1")[0]).toMatchObject({ muted: true, deafened: false });
  });

  it("drops a state change for a participant not in the call", () => {
    store.applySnapshot("room-1", "call-1", [{ did: "did:plc:a" }]);
    expect(store.applyState("room-1", "did:plc:b", true, false)).toBe(false);
  });

  it("reports no change when a state frame repeats what it holds", () => {
    store.applySnapshot("room-1", "call-1", [{ did: "did:plc:a" }]);
    store.applyState("room-1", "did:plc:a", true, false);
    expect(store.applyState("room-1", "did:plc:a", true, false)).toBe(false);
  });

  it("treats a snapshot as authoritative and drops absent participants", () => {
    store.applySnapshot("room-1", "call-1", [{ did: "did:plc:a" }, { did: "did:plc:b" }]);

    store.applySnapshot("room-1", "call-1", [{ did: "did:plc:b" }]);

    expect(store.participants("room-1").map((p) => p.did)).toEqual(["did:plc:b"]);
  });

  it("keeps held mute flags across a snapshot that omits them", () => {
    store.applySnapshot("room-1", "call-1", [{ did: "did:plc:a" }]);
    store.applyState("room-1", "did:plc:a", true, true);

    store.applySnapshot("room-1", "call-1", [{ did: "did:plc:a" }]);

    expect(store.participants("room-1")[0]).toMatchObject({ muted: true, deafened: true });
  });

  it("treats a null callId snapshot as no call", () => {
    store.applySnapshot("room-1", "call-1", [{ did: "did:plc:a" }]);
    store.applySnapshot("room-1", null, []);
    expect(store.hasActiveCall("room-1")).toBe(false);
  });
});
