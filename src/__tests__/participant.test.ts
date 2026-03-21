import { describe, it, expect, beforeEach } from "vitest";
import { ParticipantRegistry } from "../participant.js";

describe("ParticipantRegistry", () => {
  let registry: ParticipantRegistry;

  beforeEach(() => {
    registry = new ParticipantRegistry();
  });

  it("adds a participant and assigns an id", () => {
    const p = registry.add("alice", "host", null);
    expect(p.id).toBeTruthy();
    expect(p.name).toBe("alice");
    expect(p.role).toBe("host");
    expect(p.ws).toBeNull();
    expect(p.agentMode).toBe(false);
    expect(p.contextMode).toBe("full");
  });

  it("retrieves participant by id", () => {
    const p = registry.add("bob", "participant", null);
    expect(registry.getById(p.id)).toBe(p);
  });

  it("retrieves participant by name", () => {
    const p = registry.add("charlie", "participant", null);
    expect(registry.getByName("charlie")).toBe(p);
  });

  it("enforces name uniqueness (case-insensitive)", () => {
    registry.add("Alice", "host", null);
    expect(() => registry.add("alice", "participant", null)).toThrow(
      'Name "alice" is already taken'
    );
    expect(() => registry.add("ALICE", "participant", null)).toThrow(
      'Name "ALICE" is already taken'
    );
  });

  it("isNameAvailable returns correct result", () => {
    registry.add("dave", "participant", null);
    expect(registry.isNameAvailable("dave")).toBe(false);
    expect(registry.isNameAvailable("Dave")).toBe(false);
    expect(registry.isNameAvailable("eve")).toBe(true);
  });

  it("removes participant by id", () => {
    const p = registry.add("frank", "participant", null);
    expect(registry.size()).toBe(1);
    const removed = registry.remove(p.id);
    expect(removed).toBe(p);
    expect(registry.size()).toBe(0);
    expect(registry.getById(p.id)).toBeUndefined();
  });

  it("remove returns undefined for non-existent id", () => {
    expect(registry.remove("nonexistent")).toBeUndefined();
  });

  it("getAll returns all participants", () => {
    registry.add("alice", "host", null);
    registry.add("bob", "participant", null);
    registry.add("charlie", "participant", null);
    expect(registry.getAll()).toHaveLength(3);
  });

  it("getRemote returns only non-host participants", () => {
    registry.add("alice", "host", null);
    registry.add("bob", "participant", null);
    registry.add("charlie", "participant", null);
    const remote = registry.getRemote();
    expect(remote).toHaveLength(2);
    expect(remote.map((p) => p.name).sort()).toEqual(["bob", "charlie"]);
  });

  it("getHost returns the host participant", () => {
    const host = registry.add("alice", "host", null);
    registry.add("bob", "participant", null);
    expect(registry.getHost()).toBe(host);
  });

  it("size returns correct count", () => {
    expect(registry.size()).toBe(0);
    registry.add("alice", "host", null);
    expect(registry.size()).toBe(1);
    registry.add("bob", "participant", null);
    expect(registry.size()).toBe(2);
  });

  it("toInfoList returns participant info without ws", () => {
    registry.add("alice", "host", null);
    registry.add("bob", "participant", null);
    const list = registry.toInfoList();
    expect(list).toHaveLength(2);
    expect(list[0]).toHaveProperty("id");
    expect(list[0]).toHaveProperty("name");
    expect(list[0]).toHaveProperty("role");
    expect(list[0]).toHaveProperty("agentMode");
    expect(list[0]).toHaveProperty("contextMode");
    expect(list[0]).not.toHaveProperty("ws");
  });

  it("toIdentity returns id, name, role only", () => {
    const p = registry.add("alice", "host", null);
    const identity = registry.toIdentity(p);
    expect(identity).toEqual({
      id: p.id,
      name: "alice",
      role: "host",
    });
  });

  it("emits participant_joined event on add", () => {
    const events: string[] = [];
    registry.on("participant_joined", (p) => events.push(p.name));
    registry.add("alice", "host", null);
    expect(events).toEqual(["alice"]);
  });

  it("emits participant_left event on remove", () => {
    const events: string[] = [];
    registry.on("participant_left", (p) => events.push(p.name));
    const p = registry.add("alice", "host", null);
    registry.remove(p.id);
    expect(events).toEqual(["alice"]);
  });

  it("name becomes available after participant is removed", () => {
    const p = registry.add("alice", "host", null);
    expect(registry.isNameAvailable("alice")).toBe(false);
    registry.remove(p.id);
    expect(registry.isNameAvailable("alice")).toBe(true);
  });
});
