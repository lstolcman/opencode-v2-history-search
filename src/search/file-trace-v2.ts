import type { Database } from "bun:sqlite";
import type { FileTraceResult, TraceFileOptions } from "./file-trace";

type TraceRow = {
  session_id: string;
  session_title: string;
  message_id: string;
  message_time: number;
  tool_name: string | null;
  file_path: string | null;
  patch_files: string | null;
};

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function isMatch(path: string, query: string): boolean {
  if (path === query) return true;

  // V2 tool inputs normally contain absolute paths. A relative query such as
  // "src/index.ts" should still match an absolute path.
  const isAbsolute = /^[A-Za-z]:\//.test(query) || query.startsWith("/");
  if (isAbsolute) return false;
  return path.endsWith(`/${query}`);
}

export function traceFileSqliteV2(
  db: Database,
  projectID: string | null,
  queryPath: string,
  options?: TraceFileOptions,
): FileTraceResult[] {
  const normalizedQuery = normalizePath(queryPath);
  const likePattern = `%${normalizedQuery}%`;

  const projectFilter = projectID !== null ? "AND s.project_id = ?" : "";
  const sql = `
    SELECT
      s.id AS session_id,
      COALESCE(NULLIF(s.title, ''), s.slug, '(untitled)') AS session_title,
      sm.id AS message_id,
      sm.time_created AS message_time,
      json_extract(je.value, '$.name') AS tool_name,
      COALESCE(
        json_extract(je.value, '$.state.input.filePath'),
        json_extract(je.value, '$.state.input.path')
      ) AS file_path,
      json_extract(je.value, '$.files') AS patch_files
    FROM session_v2 s
    JOIN session_message sm ON sm.session_id = s.id
    JOIN json_each(json_extract(sm.data, '$.content')) je
    WHERE sm.type = 'assistant'
      AND json_valid(sm.data)
      AND (
        (
          json_extract(je.value, '$.type') = 'tool'
          AND json_extract(je.value, '$.name') IN ('write', 'edit', 'apply_patch', 'patch')
          AND REPLACE(
            COALESCE(
              json_extract(je.value, '$.state.input.filePath'),
              json_extract(je.value, '$.state.input.path')
            ),
            '\\',
            '/'
          ) LIKE ?
        )
        OR (
          json_extract(je.value, '$.type') = 'patch'
          AND REPLACE(json_extract(je.value, '$.files'), '\\', '/') LIKE ?
        )
      )
      ${projectFilter}
    ORDER BY message_time DESC
  `;

  const binds: string[] = projectID !== null
    ? [likePattern, likePattern, projectID]
    : [likePattern, likePattern];

  const rows = db.query(sql).all(...binds) as TraceRow[];

  const candidates: Array<{
    sessionID: string;
    sessionTitle: string;
    messageID: string;
    timestamp: number;
    toolName: string | null;
    filePath: string;
  }> = [];

  for (const row of rows) {
    let matchedPath: string | null = null;

    if (row.file_path) {
      const normalized = normalizePath(row.file_path);
      if (isMatch(normalized, normalizedQuery)) {
        matchedPath = normalized;
      }
    }

    if (!matchedPath && row.patch_files) {
      try {
        const parsed = JSON.parse(row.patch_files) as unknown;
        if (Array.isArray(parsed)) {
          for (const file of parsed) {
            if (typeof file !== "string") continue;
            const normalized = normalizePath(file);
            if (isMatch(normalized, normalizedQuery)) {
              matchedPath = normalized;
              break;
            }
          }
        }
      } catch {
        // Ignore malformed patch payloads.
      }
    }

    if (matchedPath) {
      candidates.push({
        sessionID: row.session_id,
        sessionTitle: row.session_title,
        messageID: row.message_id,
        timestamp: row.message_time,
        toolName: row.tool_name,
        filePath: matchedPath,
      });
    }
  }

  const seen = new Set<string>();
  const deduped: typeof candidates = [];
  for (const candidate of candidates) {
    const key = `${candidate.sessionID}|${candidate.messageID}|${candidate.filePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }

  let earliestTime = Infinity;
  let earliestIndex = -1;
  for (let i = 0; i < deduped.length; i++) {
    const candidate = deduped[i]!;
    if (candidate.timestamp < earliestTime) {
      earliestTime = candidate.timestamp;
      earliestIndex = i;
    }
  }

  const findUserPrompt = db.query(`
    SELECT json_extract(data, '$.text') AS text
    FROM session_message
    WHERE session_id = ?
      AND type = 'user'
      AND time_created < ?
      AND json_valid(data)
    ORDER BY time_created DESC
    LIMIT 1
  `);

  const results: FileTraceResult[] = deduped.map((candidate, index) => {
    const promptRow = findUserPrompt.get(candidate.sessionID, candidate.timestamp) as
      | { text: string | null }
      | undefined;

    return {
      sessionID: candidate.sessionID,
      sessionTitle: candidate.sessionTitle,
      timestamp: candidate.timestamp,
      firstTouch: index === earliestIndex,
      userPrompt: promptRow?.text ?? null,
      toolName: candidate.toolName,
      filePath: candidate.filePath,
    };
  });

  return results.slice(0, options?.limit ?? 50);
}
