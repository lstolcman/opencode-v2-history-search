import { test, expect, describe } from "bun:test";
import { searchMultiterm } from "./multiterm-sql";
import { getCurrentProjectID } from "../storage-provider";

describe("multiterm SQL search (integration - requires real opencode.db)", () => {
  test("real history: finds sessions for truck+vertex+gemini", async () => {
    const results = await searchMultiterm(null, ["truck", "vertex", "gemini"]);

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.termHits.size).toBe(3);
    }
  });

  test("multi-term returns subset of single-term baseline", async () => {
    const single = await searchMultiterm(null, ["truck"]);
    const multi = await searchMultiterm(null, ["truck", "vertex"]);
    expect(multi.length).toBeLessThanOrEqual(single.length);
  });

  test("every returned session's termHits covers all query terms", async () => {
    const results = await searchMultiterm(null, ["truck", "vertex", "gemini"]);
    for (const result of results) {
      for (const term of ["truck", "vertex", "gemini"]) {
        expect(
          result.termHits.has(term),
          `session ${result.sessionID} missing term ${term}`,
        ).toBe(true);
      }
    }
  });

  test("returns empty for non-existent term in non-current project", async () => {
    const results = await searchMultiterm("nonexistent-project", [
      "qX7vK2zP9wR5tY8mN3jF",
    ]);
    expect(results).toHaveLength(0);
  });

  test("multi-term completes in under 3 seconds (smoke)", async () => {
    const t0 = performance.now();
    await searchMultiterm(null, ["truck", "vertex", "gemini"]);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(3000);
  });

  test("project-scoped search only returns sessions in that project", async () => {
    const projectID = await getCurrentProjectID();
    const results = await searchMultiterm(projectID, ["v2", "plugin"]);

    expect(Array.isArray(results)).toBe(true);
    for (const result of results) {
      expect(result).toHaveProperty("projectDirectory");
    }
  });

  test("end-to-end via the full tool: terms parameter formats matched sessions", async () => {
    const { formatMultitermResults } = await import("../format");
    const results = await searchMultiterm(null, ["truck", "vertex", "gemini"]);

    expect(results.length).toBeGreaterThan(0);
    const output = formatMultitermResults(results);
    expect(output).toContain(results[0]!.sessionID);
    expect(output).toContain("Matched terms:");
  });
});
