import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import type { Session, Message, Part } from "./storage";
import {
  listSessionsSqliteV2,
  listMessagesSqliteV2,
  listPartsSqliteV2,
} from "./storage-sqlite-v2";
import { findProjectID, isV2Schema } from "./storage-sqlite";
import { traceFileSqliteV2 } from "./search/file-trace-v2";
import { searchMultitermV2, type MultitermV2Source } from "./search/multiterm-v2";

describe("OpenCode V2 SQLite storage", () => {
  let db: Database;

  const userData = JSON.stringify({
    time: { created: 1706745600000 },
    text: "Help me implement storage",
    files: [],
    agents: [],
  });

  const assistantData = JSON.stringify({
    time: { created: 1706745601000 },
    agent: "build",
    content: [
      { type: "reasoning", text: "thinking..." },
      { type: "text", text: "Implemented storage support" },
      {
        type: "tool",
        id: "call_001",
        name: "write",
        state: {
          status: "completed",
          input: { path: "C:\\mock\\src\\storage.ts", content: "export {}" },
          content: [{ type: "text", text: "Created src/storage.ts" }],
          metadata: {},
        },
      },
    ],
  });

  beforeAll(() => {
    db = new Database(":memory:");
    db.run(`CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT,
      slug TEXT,
      directory TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    )`);

    db.run(`INSERT INTO project VALUES ('proj1', 'C:/mock')`);
    db.run(`INSERT INTO project VALUES ('proj2', 'C:/other')`);
    db.run(
      `INSERT INTO session_v2 VALUES ('ses_001', 'proj1', 'V2 storage test', 'slug-one', 'C:/mock', 1706745600000, 1706745602000)`,
    );
    db.run(
      `INSERT INTO session_v2 VALUES ('ses_002', 'proj2', NULL, 'slug-two', NULL, 1706745500000, 1706745501000)`,
    );

    db.run(
      `INSERT INTO session_message VALUES ('msg_001', 'ses_001', 'user', 1, 1706745600000, 1706745600000, ?)`,
      [userData],
    );
    db.run(
      `INSERT INTO session_message VALUES ('msg_002', 'ses_001', 'assistant', 2, 1706745601000, 1706745601000, ?)`,
      [assistantData],
    );
    db.run(
      `INSERT INTO session_message VALUES ('msg_003', 'ses_001', 'idle', 3, 1706745601500, 1706745601500, '{}')`,
    );
    db.run(
      `INSERT INTO session_message VALUES ('msg_004', 'ses_002', 'user', 1, 1706745500000, 1706745500000, ?)`,
      [
        JSON.stringify({
          time: { created: 1706745500000 },
          text: "unrelated topic",
          files: [],
        }),
      ],
    );
  });

  afterAll(() => {
    db.close();
  });

  test("detects the V2 schema", () => {
    expect(isV2Schema(db)).toBe(true);
  });

  test("finds the current project by worktree prefix", () => {
    expect(findProjectID(db, "C:\\mock\\subdir")).toBe("proj1");
    expect(findProjectID(db, "C:/other")).toBe("proj2");
    expect(findProjectID(db, "C:/unknown")).toBeUndefined();
  });

  test("lists sessions globally and scoped by project", async () => {
    const all: Session[] = [];
    for await (const session of listSessionsSqliteV2(null, db)) all.push(session);

    expect(all).toHaveLength(2);
    expect(all[0]?.id).toBe("ses_001");
    expect(all[1]?.title).toBe("slug-two");

    const scoped: Session[] = [];
    for await (const session of listSessionsSqliteV2("proj1", db)) scoped.push(session);

    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.id).toBe("ses_001");
    expect(scoped[0]?.directory).toBe("C:/mock");
  });

  test("lists user and assistant messages and filters by role", async () => {
    const messages: Message[] = [];
    for await (const message of listMessagesSqliteV2("ses_001", undefined, db)) {
      messages.push(message);
    }

    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.agent).toBe("build");

    const userOnly: Message[] = [];
    for await (const message of listMessagesSqliteV2("ses_001", "user", db)) {
      userOnly.push(message);
    }

    expect(userOnly).toHaveLength(1);
    expect(userOnly[0]?.id).toBe("msg_001");
  });

  test("maps user message text to a text part", async () => {
    const parts: Part[] = [];
    for await (const part of listPartsSqliteV2("msg_001", db)) parts.push(part);

    expect(parts).toHaveLength(1);
    expect(parts[0]?.type).toBe("text");
    expect(parts[0]?.text).toBe("Help me implement storage");
  });

  test("maps V2 message content to text and tool parts", async () => {
    const parts: Part[] = [];
    for await (const part of listPartsSqliteV2("msg_002", db)) parts.push(part);

    const text = parts.find((part) => part.type === "text");
    expect(text?.text).toBe("Implemented storage support");

    const tool = parts.find((part) => part.type === "tool");
    expect(tool?.tool).toBe("write");
    expect(tool?.state?.input).toEqual({
      path: "C:\\mock\\src\\storage.ts",
      content: "export {}",
    });
    expect(tool?.state?.output).toBe("Created src/storage.ts");
    expect(parts.some((part) => part.type === "text" && part.text === "thinking...")).toBe(false);
  });

  test("traces file writes in V2 tool content", () => {
    const results = traceFileSqliteV2(db, "proj1", "src/storage.ts");

    expect(results).toHaveLength(1);
    expect(results[0]?.filePath).toBe("C:/mock/src/storage.ts");
    expect(results[0]?.toolName).toBe("write");
    expect(results[0]?.userPrompt).toBe("Help me implement storage");
    expect(results[0]?.firstTouch).toBe(true);
  });

  test("multi-term search matches title and message content", async () => {
    const sessions: Session[] = [];
    for await (const session of listSessionsSqliteV2(null, db)) sessions.push(session);

    const messages = new Map<string, Message[]>();
    const parts = new Map<string, Part[]>();
    for (const session of sessions) {
      const sessionMessages: Message[] = [];
      for await (const message of listMessagesSqliteV2(session.id, undefined, db)) {
        sessionMessages.push(message);
        const messageParts: Part[] = [];
        for await (const part of listPartsSqliteV2(message.id, db)) {
          messageParts.push(part);
        }
        parts.set(message.id, messageParts);
      }
      messages.set(session.id, sessionMessages);
    }

    const source: MultitermV2Source = {
      async *listSessions() {
        for (const session of sessions) yield session;
      },
      async *listMessages(sessionID) {
        for (const message of messages.get(sessionID) ?? []) yield message;
      },
      async *listParts(messageID) {
        for (const part of parts.get(messageID) ?? []) yield part;
      },
    };

    const results = await searchMultitermV2(
      null,
      ["storage", "implement"],
      undefined,
      source,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.sessionID).toBe("ses_001");
    expect(results[0]?.termHits.size).toBe(2);
  });
});
