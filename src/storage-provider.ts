import {
  dbExists,
  isV2Schema,
  listSessionsSqlite,
  listMessagesSqlite,
  listPartsSqlite,
} from "./storage-sqlite";
import {
  listSessionsSqliteV2,
  listMessagesSqliteV2,
  listPartsSqliteV2,
} from "./storage-sqlite-v2";
import {
  listSessions as listSessionsJSON,
  listMessages as listMessagesJSON,
  listParts as listPartsJSON,
  getCurrentProjectID,
  getStorageDir,
} from "./storage";
import type { Session, Message, Part } from "./storage";

type StorageKind = "v2" | "v1" | "json";

let cachedKind: StorageKind | undefined;

function storageKind(): StorageKind {
  if (!cachedKind) {
    cachedKind = !dbExists() ? "json" : isV2Schema() ? "v2" : "v1";
  }
  return cachedKind;
}

export async function* listSessions(
  projectID: string | null,
): AsyncGenerator<Session> {
  switch (storageKind()) {
    case "v2":
      yield* listSessionsSqliteV2(projectID);
      return;
    case "v1":
      yield* listSessionsSqlite(projectID);
      return;
    default:
      yield* listSessionsJSON(projectID);
  }
}

export async function* listMessages(
  sessionID: string,
  role?: "user" | "assistant",
): AsyncGenerator<Message> {
  switch (storageKind()) {
    case "v2":
      yield* listMessagesSqliteV2(sessionID, role);
      return;
    case "v1":
      yield* listMessagesSqlite(sessionID, role);
      return;
    default:
      yield* listMessagesJSON(sessionID, role);
  }
}

export async function* listParts(messageID: string): AsyncGenerator<Part> {
  switch (storageKind()) {
    case "v2":
      yield* listPartsSqliteV2(messageID);
      return;
    case "v1":
      yield* listPartsSqlite(messageID);
      return;
    default:
      yield* listPartsJSON(messageID);
  }
}

export { getCurrentProjectID, getStorageDir };
export type { Session, Message, Part };
