import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { TeamCodingServer } from "../server.js";
import { deriveKey, encrypt, decrypt } from "../crypto.js";

const TEST_PASSWORD = "test1234";
const TEST_SESSION_CODE = "cd-multi-test";
const TEST_KEY = deriveKey(TEST_PASSWORD, TEST_SESSION_CODE);

function sendEncrypted(ws: WebSocket, msg: object): void {
  ws.send(encrypt(JSON.stringify(msg), TEST_KEY));
}

function receiveDecrypted(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (data) => {
      const decrypted = decrypt(data.toString(), TEST_KEY);
      resolve(JSON.parse(decrypted));
    });
  });
}

async function joinAsParticipant(
  port: number,
  name: string,
): Promise<{ ws: WebSocket; joinResult: Record<string, unknown> }> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  await new Promise<void>((resolve) => ws.on("open", resolve));

  const joinResult = receiveDecrypted(ws);
  sendEncrypted(ws, {
    type: "join",
    user: name,
    passwordHash: TEST_PASSWORD,
    timestamp: Date.now(),
  });
  const result = await joinResult;
  return { ws, joinResult: result };
}

describe("Multi-participant server", () => {
  let server: TeamCodingServer;
  const openWs: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of openWs) {
      ws.close();
    }
    openWs.length = 0;
    if (server) await server.stop().catch(() => {});
  });

  it("allows multiple participants to join", async () => {
    server = new TeamCodingServer({
      hostUser: "host",
      password: TEST_PASSWORD,
      sessionCode: TEST_SESSION_CODE,
    });
    server.registerHost();
    const port = await server.start();

    const { ws: ws1, joinResult: r1 } = await joinAsParticipant(port, "alice");
    openWs.push(ws1);
    expect(r1.type).toBe("join_accepted");
    expect(r1.participantId).toBeTruthy();

    const { ws: ws2, joinResult: r2 } = await joinAsParticipant(port, "bob");
    openWs.push(ws2);
    expect(r2.type).toBe("join_accepted");
    expect(r2.participantId).toBeTruthy();

    // Each gets a different participant ID
    expect(r1.participantId).not.toBe(r2.participantId);

    // Both should have received the participant list
    expect(r1.participants).toBeDefined();
    expect(r2.participants).toBeDefined();
  });

  it("broadcasts participant_joined to existing participants", async () => {
    server = new TeamCodingServer({
      hostUser: "host",
      password: TEST_PASSWORD,
      sessionCode: TEST_SESSION_CODE,
    });
    server.registerHost();
    const port = await server.start();

    const { ws: ws1 } = await joinAsParticipant(port, "alice");
    openWs.push(ws1);

    // Listen for participant_joined on alice's ws
    const joinedPromise = receiveDecrypted(ws1);

    const { ws: ws2 } = await joinAsParticipant(port, "bob");
    openWs.push(ws2);

    const joined = await joinedPromise;
    expect(joined.type).toBe("participant_joined");
    expect((joined.participant as any).name).toBe("bob");
    expect((joined.participant as any).role).toBe("participant");
    expect(joined.seq).toBeDefined();
  });

  it("broadcasts participant_left when someone disconnects", async () => {
    server = new TeamCodingServer({
      hostUser: "host",
      password: TEST_PASSWORD,
      sessionCode: TEST_SESSION_CODE,
    });
    server.registerHost();
    const port = await server.start();

    const { ws: ws1 } = await joinAsParticipant(port, "alice");
    openWs.push(ws1);
    const { ws: ws2 } = await joinAsParticipant(port, "bob");
    openWs.push(ws2);

    // Consume the participant_joined notification alice received about bob
    await receiveDecrypted(ws1);

    // Listen for participant_left
    const leftPromise = receiveDecrypted(ws1);
    ws2.close();
    openWs.splice(openWs.indexOf(ws2), 1);

    const left = await leftPromise;
    expect(left.type).toBe("participant_left");
    expect((left.participant as any).name).toBe("bob");
  });

  it("rejects duplicate names", async () => {
    server = new TeamCodingServer({
      hostUser: "host",
      password: TEST_PASSWORD,
      sessionCode: TEST_SESSION_CODE,
    });
    server.registerHost();
    const port = await server.start();

    const { ws: ws1 } = await joinAsParticipant(port, "alice");
    openWs.push(ws1);

    // Try to join with same name
    const { ws: ws2, joinResult: r2 } = await joinAsParticipant(port, "alice");
    openWs.push(ws2);
    expect(r2.type).toBe("join_rejected");
    expect(r2.reason).toContain("already taken");
  });

  it("rejects joining with host's name", async () => {
    server = new TeamCodingServer({
      hostUser: "host",
      password: TEST_PASSWORD,
      sessionCode: TEST_SESSION_CODE,
    });
    server.registerHost();
    const port = await server.start();

    const { ws: ws1, joinResult: r1 } = await joinAsParticipant(port, "host");
    openWs.push(ws1);
    expect(r1.type).toBe("join_rejected");
    expect(r1.reason).toContain("already taken");
  });

  it("enforces max participants limit", async () => {
    server = new TeamCodingServer({
      hostUser: "host",
      password: TEST_PASSWORD,
      sessionCode: TEST_SESSION_CODE,
      maxParticipants: 3, // host + 2 participants
    });
    server.registerHost();
    const port = await server.start();

    const { ws: ws1 } = await joinAsParticipant(port, "alice");
    openWs.push(ws1);
    const { ws: ws2 } = await joinAsParticipant(port, "bob");
    openWs.push(ws2);

    // Third participant should be rejected (host=1, alice=2, bob=3 = max)
    // The server rejects at handleConnection before join — it sends a join_rejected
    // then closes the ws. We listen for the first message which is the rejection.
    const ws3 = new WebSocket(`ws://localhost:${port}`);
    openWs.push(ws3);

    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws3.on("message", (data) => {
        const decrypted = decrypt(data.toString(), TEST_KEY);
        resolve(JSON.parse(decrypted));
      });
      ws3.on("close", () => reject(new Error("closed without message")));
      ws3.on("error", reject);
    });

    expect(result.type).toBe("join_rejected");
    expect(result.reason).toContain("full");
  });

  it("fans out chat messages to all participants", async () => {
    server = new TeamCodingServer({
      hostUser: "host",
      password: TEST_PASSWORD,
      sessionCode: TEST_SESSION_CODE,
    });
    server.registerHost();
    const port = await server.start();

    const { ws: ws1 } = await joinAsParticipant(port, "alice");
    openWs.push(ws1);
    const { ws: ws2 } = await joinAsParticipant(port, "bob");
    openWs.push(ws2);

    // Consume the participant_joined notifications
    await receiveDecrypted(ws1); // alice receives bob joined

    // Alice sends a chat message
    const bobReceived = receiveDecrypted(ws2);
    const hostReceived = new Promise<Record<string, unknown>>((resolve) => {
      server.on("server_message", (msg) => {
        if (msg.type === "chat_received") resolve(msg);
      });
    });

    sendEncrypted(ws1, {
      type: "chat",
      id: "chat-1",
      user: "alice",
      text: "hello everyone",
      timestamp: Date.now(),
    });

    const [bobMsg, hostMsg] = await Promise.all([bobReceived, hostReceived]);

    // Bob should receive the chat
    expect(bobMsg.type).toBe("chat_received");
    expect(bobMsg.user).toBe("alice");
    expect(bobMsg.text).toBe("hello everyone");
    expect(bobMsg.seq).toBeDefined();
    expect((bobMsg.sender as any).name).toBe("alice");
    expect((bobMsg.sender as any).role).toBe("participant");

    // Host should also receive it via event
    expect(hostMsg.type).toBe("chat_received");
    expect((hostMsg as any).user).toBe("alice");
  });

  it("assigns monotonically increasing sequence numbers", async () => {
    server = new TeamCodingServer({
      hostUser: "host",
      password: TEST_PASSWORD,
      sessionCode: TEST_SESSION_CODE,
    });
    server.registerHost();
    const port = await server.start();

    const { ws: ws1 } = await joinAsParticipant(port, "alice");
    openWs.push(ws1);
    const { ws: ws2 } = await joinAsParticipant(port, "bob");
    openWs.push(ws2);

    // Consume participant_joined
    await receiveDecrypted(ws1);

    // Send two messages and check sequence numbers increase
    const msg1Promise = receiveDecrypted(ws2);
    sendEncrypted(ws1, {
      type: "chat",
      id: "chat-seq-1",
      user: "alice",
      text: "first",
      timestamp: Date.now(),
    });
    const msg1 = await msg1Promise;

    const msg2Promise = receiveDecrypted(ws2);
    sendEncrypted(ws1, {
      type: "chat",
      id: "chat-seq-2",
      user: "alice",
      text: "second",
      timestamp: Date.now(),
    });
    const msg2 = await msg2Promise;

    expect(typeof msg1.seq).toBe("number");
    expect(typeof msg2.seq).toBe("number");
    expect((msg2.seq as number)).toBeGreaterThan(msg1.seq as number);
  });

  it("kickParticipant removes a specific participant by name", async () => {
    server = new TeamCodingServer({
      hostUser: "host",
      password: TEST_PASSWORD,
      sessionCode: TEST_SESSION_CODE,
    });
    server.registerHost();
    const port = await server.start();

    const { ws: ws1 } = await joinAsParticipant(port, "alice");
    openWs.push(ws1);
    const { ws: ws2 } = await joinAsParticipant(port, "bob");
    openWs.push(ws2);

    // Consume notifications
    await receiveDecrypted(ws1);

    // Kick alice
    const result = server.kickParticipant("alice");
    expect(result).toBe(true);

    // Bob should receive participant_left
    const leftMsg = await receiveDecrypted(ws2);
    expect(leftMsg.type).toBe("participant_left");
    expect((leftMsg.participant as any).name).toBe("alice");

    // Cannot kick host
    expect(server.kickParticipant("host")).toBe(false);
  });

  it("routes whispers only to targeted participants", async () => {
    server = new TeamCodingServer({
      hostUser: "host",
      password: TEST_PASSWORD,
      sessionCode: TEST_SESSION_CODE,
    });
    server.registerHost();
    const port = await server.start();

    const { ws: ws1 } = await joinAsParticipant(port, "alice");
    openWs.push(ws1);

    // Register listener BEFORE bob joins to avoid race with participant_joined delivery
    const aliceSeeBob = receiveDecrypted(ws1);
    const { ws: ws2 } = await joinAsParticipant(port, "bob");
    openWs.push(ws2);
    await aliceSeeBob; // consume participant_joined(bob) on ws1

    // Register listeners BEFORE charlie joins
    const aliceSeeCharlie = receiveDecrypted(ws1);
    const bobSeeCharlie = receiveDecrypted(ws2);
    const { ws: ws3 } = await joinAsParticipant(port, "charlie");
    openWs.push(ws3);
    await aliceSeeCharlie; // consume participant_joined(charlie) on ws1
    await bobSeeCharlie;   // consume participant_joined(charlie) on ws2

    // Alice whispers to bob only
    const bobWhisper = receiveDecrypted(ws2);
    const aliceEcho = receiveDecrypted(ws1); // sender gets echo

    sendEncrypted(ws1, {
      type: "whisper",
      id: "w1",
      targets: ["bob"],
      text: "secret for bob",
      timestamp: Date.now(),
    });

    const [bobMsg, aliceMsg] = await Promise.all([bobWhisper, aliceEcho]);

    expect(bobMsg.type).toBe("whisper_received");
    expect(bobMsg.text).toBe("secret for bob");
    expect((bobMsg.sender as any).name).toBe("alice");
    expect(bobMsg.targets).toEqual(["bob"]);

    // Alice should get the echo too
    expect(aliceMsg.type).toBe("whisper_received");
    expect(aliceMsg.text).toBe("secret for bob");

    // Charlie should NOT have received anything — verify by sending a chat
    // and checking charlie gets THAT (not the whisper)
    const charlieMsg = receiveDecrypted(ws3);
    sendEncrypted(ws1, {
      type: "chat",
      id: "chat-after-whisper",
      user: "alice",
      text: "public message",
      timestamp: Date.now(),
    });
    const cMsg = await charlieMsg;
    expect(cMsg.type).toBe("chat_received");
    expect(cMsg.text).toBe("public message");
  });

  it("cannot kick the host", async () => {
    server = new TeamCodingServer({
      hostUser: "host",
      password: TEST_PASSWORD,
      sessionCode: TEST_SESSION_CODE,
    });
    server.registerHost();
    await server.start();

    expect(server.kickParticipant("host")).toBe(false);
  });
});
