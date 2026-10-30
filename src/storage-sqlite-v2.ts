import { Database } from "bun:sqlite";
import { getDbPath } from "./storage-sqlite";
import type { Session, Message, Part } from "./storage";

// OpenCode V2 stores conversation history in `session_v2` and
// `session_message`. Message content lives in the `data` JSON column, so this
// adapter maps that shape onto the same Session/Message/Part types used by the
// V1 storage layer.

let cachedDb: Database | undefined;

function openDb(): Database {
  if (!cachedDb) cachedDb = new Database(getDbPath(), { readonly: true });
  return cachedDb;
}

type SessionRow = {
  id: string;
  project_id: string;
  title: string | null;
  slug: string | null;
  directory: string | null;
  time_created: number;
  time_updated: number;
};

type MessageRow = {
  id: string;
  session_id: string;
  type: "user" | "assistant";
  time_created: number;
  data: string;
};

function sessionTitle(row: SessionRow): string {
  return row.title || row.slug || "(untitled)";
}

function parseJson<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function filePathOf(file: unknown): string | undefined {
  if (typeof file === "string") return file;
  if (file && typeof file === "object") {
    const value = file as Record<string, unknown>;
    const candidate = value.path ?? value.filePath ?? value.uri ?? value.name;
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

function toolOutput(state: Record<string, unknown> | undefined): string | undefined {
  if (!state) return undefined;
  if (typeof state.output === "string") return state.output;

  if (Array.isArray(state.content)) {
    const text = state.content
      .map((item) =>
        typeof item === "string"
          ? item
          : typeof item?.text === "string"
            ? item.text
            : "",
      )
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }

  if (state.output != null) return JSON.stringify(state.output);
  return undefined;
}

export async function* listSessionsSqliteV2(
  projectID: string | null,
  db?: Database,
): AsyncGenerator<Session> {
  const _db = db ?? openDb();
  const select = `
    SELECT
      s.id,
      s.project_id,
      s.title,
      s.slug,
      COALESCE(NULLIF(s.directory, ''), p.worktree, '') AS directory,
      s.time_created,
      s.time_updated
    FROM session_v2 s
    LEFT JOIN project p ON p.id = s.project_id
  `;

  const rows = (
    projectID
      ? _db
          .query(`${select} WHERE s.project_id = ? ORDER BY s.time_updated DESC`)
          .all(projectID)
      : _db.query(`${select} ORDER BY s.time_updated DESC`).all()
  ) as SessionRow[];

  for (const row of rows) {
    yield {
      id: row.id,
      projectID: row.project_id,
      title: sessionTitle(row),
      directory: row.directory ?? "",
      time: { created: row.time_created, updated: row.time_updated },
    };
  }
}

export async function* listMessagesSqliteV2(
  sessionID: string,
  role?: "user" | "assistant",
  db?: Database,
): AsyncGenerator<Message> {
  const _db = db ?? openDb();
  const rows = _db
    .query(
      `SELECT id, session_id, type, time_created, data
       FROM session_message
       WHERE session_id = ? AND type IN ('user', 'assistant')
       ORDER BY time_created ASC, seq ASC`,
    )
    .all(sessionID) as MessageRow[];

  for (const row of rows) {
    if (role && row.type !== role) continue;
    const data = parseJson<{ agent?: string; time?: { created?: number } }>(row.data);
    yield {
      id: row.id,
      sessionID: row.session_id,
      role: row.type,
      agent: data?.agent ?? "",
      time: { created: data?.time?.created ?? row.time_created },
    };
  }
}

export async function* listPartsSqliteV2(
  messageID: string,
  db?: Database,
): AsyncGenerator<Part> {
  const _db = db ?? openDb();
  const row = _db
    .query(
      `SELECT id, session_id, type, data
       FROM session_message
       WHERE id = ?`,
    )
    .get(messageID) as MessageRow | undefined;

  if (!row) return;

  const data = parseJson<{
    text?: string;
    files?: unknown[];
    content?: Array<Record<string, unknown>>;
  }>(row.data);
  if (!data) return;

  if (row.type === "user") {
    if (typeof data.text === "string" && data.text.length > 0) {
      yield {
        id: `${row.id}:text`,
        messageID: row.id,
        sessionID: row.session_id,
        type: "text",
        text: data.text,
      };
    }

    const files = (data.files ?? []).map(filePathOf).filter((file): file is string => !!file);
    if (files.length > 0) {
      yield {
        id: `${row.id}:files`,
        messageID: row.id,
        sessionID: row.session_id,
        type: "patch",
        files,
      };
    }
    return;
  }

  const content = Array.isArray(data.content) ? data.content : [];
  if (content.length === 0 && typeof data.text === "string" && data.text.length > 0) {
    yield {
      id: `${row.id}:text`,
      messageID: row.id,
      sessionID: row.session_id,
      type: "text",
      text: data.text,
    };
    return;
  }

  for (const [index, item] of content.entries()) {
    const type = item?.type;
    const id = typeof item.id === "string" ? item.id : `${row.id}:${index}`;

    if (type === "text" && typeof item.text === "string") {
      yield {
        id,
        messageID: row.id,
        sessionID: row.session_id,
        type: "text",
        text: item.text,
      };
      continue;
    }

    if (type === "tool") {
      const state = (item.state ?? undefined) as Record<string, unknown> | undefined;
      yield {
        id,
        messageID: row.id,
        sessionID: row.session_id,
        type: "tool",
        tool: typeof item.name === "string" ? item.name : "",
        state: {
          input: state?.input,
          output: toolOutput(state),
          title:
            typeof state?.title === "string"
              ? state.title
              : typeof item.name === "string"
                ? item.name
                : undefined,
        },
      };
      continue;
    }

    if (type === "patch") {
      const files = Array.isArray(item.files)
        ? item.files.map(filePathOf).filter((file): file is string => !!file)
        : [];
      if (files.length > 0) {
        yield {
          id,
          messageID: row.id,
          sessionID: row.session_id,
          type: "patch",
          files,
        };
      }
    }
  }
}
