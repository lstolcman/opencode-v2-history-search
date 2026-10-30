import { listSessions, listMessages, listParts } from "../storage-provider";
import type { Part, Session, Message } from "../storage-provider";
import type { MultitermSearchMatch } from "./multiterm-sql";

export interface MultitermV2Source {
  listSessions(projectID: string | null): AsyncIterable<Session>;
  listMessages(
    sessionID: string,
    role?: "user" | "assistant",
  ): AsyncIterable<Message>;
  listParts(messageID: string): AsyncIterable<Part>;
}

const defaultSource: MultitermV2Source = {
  listSessions,
  listMessages,
  listParts,
};

function partSearchText(part: Part): string {
  if (part.type === "text") return part.text ?? "";
  if (part.type === "patch") return (part.files ?? []).join(" ");
  if (part.type === "tool") {
    return [
      part.tool ?? "",
      part.state?.title ?? "",
      part.state?.input ? JSON.stringify(part.state.input) : "",
      part.state?.output ?? "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + length + 60);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/**
 * Multi-term search for the OpenCode V2 storage schema. The V2 message data is
 * stored as JSON, so this walks the normalized Session/Message/Part stream
 * instead of issuing V1-specific SQL.
 */
export async function searchMultitermV2(
  projectID: string | null,
  terms: string[],
  options?: { limit?: number },
  source: MultitermV2Source = defaultSource,
): Promise<MultitermSearchMatch[]> {
  const limit = options?.limit ?? 50;
  const lowered = terms.map((term) => term.toLowerCase());
  const results: MultitermSearchMatch[] = [];

  for await (const session of source.listSessions(projectID)) {
    const termHits = new Map<
      string,
      { partID: string; matchType: string; excerpt: string }
    >();
    const title = session.title || "(untitled)";
    const loweredTitle = title.toLowerCase();

    for (let i = 0; i < terms.length; i++) {
      const term = terms[i]!;
      if (termHits.has(term)) continue;
      const index = loweredTitle.indexOf(lowered[i]!);
      if (index >= 0) {
        termHits.set(term, {
          partID: "title",
          matchType: "title",
          excerpt: title,
        });
      }
    }

    if (termHits.size < terms.length) {
      for await (const message of source.listMessages(session.id)) {
        for await (const part of source.listParts(message.id)) {
          const content = partSearchText(part);
          if (!content) continue;
          const loweredContent = content.toLowerCase();

          for (let i = 0; i < terms.length; i++) {
            const term = terms[i]!;
            if (termHits.has(term)) continue;
            const index = loweredContent.indexOf(lowered[i]!);
            if (index >= 0) {
              termHits.set(term, {
                partID: part.id,
                matchType: part.type,
                excerpt: excerpt(content, index, term.length),
              });
            }
          }

          if (termHits.size === terms.length) break;
        }
        if (termHits.size === terms.length) break;
      }
    }

    if (termHits.size === terms.length) {
      results.push({
        sessionID: session.id,
        sessionTitle: title,
        timestamp: session.time.updated,
        projectDirectory: session.directory,
        termHits,
      });
      if (results.length >= limit) break;
    }
  }

  return results;
}
