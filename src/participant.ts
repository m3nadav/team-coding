import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import type WebSocket from "ws";

export type ParticipantRole = "host" | "participant";
export type ContextMode = "full" | "prompt-only";

export interface ParticipantIdentity {
  id: string;
  name: string;
  role: ParticipantRole;
}

export interface Participant {
  id: string;
  name: string;
  role: ParticipantRole;
  ws: WebSocket | null; // null for the host (local participant)
  joinedAt: number;
  agentMode: boolean;
  contextMode: ContextMode;
}

export interface ParticipantInfo {
  id: string;
  name: string;
  role: ParticipantRole;
  agentMode: boolean;
  contextMode: ContextMode;
}

export class ParticipantRegistry extends EventEmitter {
  private participants = new Map<string, Participant>();
  private wsByParticipant = new Map<WebSocket, string>(); // reverse lookup: ws → id

  add(name: string, role: ParticipantRole, ws: WebSocket | null): Participant {
    if (!this.isNameAvailable(name)) {
      throw new Error(`Name "${name}" is already taken`);
    }

    const participant: Participant = {
      id: nanoid(12),
      name,
      role,
      ws,
      joinedAt: Date.now(),
      agentMode: false,
      contextMode: "full",
    };

    this.participants.set(participant.id, participant);
    if (ws) {
      this.wsByParticipant.set(ws, participant.id);
    }

    this.emit("participant_joined", participant);
    return participant;
  }

  remove(id: string): Participant | undefined {
    const participant = this.participants.get(id);
    if (!participant) return undefined;

    this.participants.delete(id);
    if (participant.ws) {
      this.wsByParticipant.delete(participant.ws);
    }

    this.emit("participant_left", participant);
    return participant;
  }

  removeByWs(ws: WebSocket): Participant | undefined {
    const id = this.wsByParticipant.get(ws);
    if (!id) return undefined;
    return this.remove(id);
  }

  getById(id: string): Participant | undefined {
    return this.participants.get(id);
  }

  getByName(name: string): Participant | undefined {
    for (const p of this.participants.values()) {
      if (p.name === name) return p;
    }
    return undefined;
  }

  getByWs(ws: WebSocket): Participant | undefined {
    const id = this.wsByParticipant.get(ws);
    if (!id) return undefined;
    return this.participants.get(id);
  }

  getAll(): Participant[] {
    return Array.from(this.participants.values());
  }

  getRemote(): Participant[] {
    return this.getAll().filter((p) => p.role !== "host");
  }

  getHost(): Participant | undefined {
    return this.getAll().find((p) => p.role === "host");
  }

  size(): number {
    return this.participants.size;
  }

  isNameAvailable(name: string): boolean {
    for (const p of this.participants.values()) {
      if (p.name.toLowerCase() === name.toLowerCase()) return false;
    }
    return true;
  }

  toInfoList(): ParticipantInfo[] {
    return this.getAll().map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      agentMode: p.agentMode,
      contextMode: p.contextMode,
    }));
  }

  toIdentity(participant: Participant): ParticipantIdentity {
    return {
      id: participant.id,
      name: participant.name,
      role: participant.role,
    };
  }
}
