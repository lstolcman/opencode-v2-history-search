import { test, expect, describe } from "bun:test";
import { searchKeyword } from "./keyword";
import { getCurrentProjectID } from "../storage-provider";

describe("keyword search (integration - requires real data)", () => {
  test("finds matches in actual history", async () => {
    const projectID = await getCurrentProjectID();
    const results = await searchKeyword(projectID, "storage", { limit: 5 });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty("sessionID");
    expect(results[0]).toHaveProperty("sessionTitle");
    expect(results[0]).toHaveProperty("excerpt");
  });

  test("case insensitive by default", async () => {
    const projectID = await getCurrentProjectID();
    const lower = await searchKeyword(projectID, "storage", { limit: 5 });
    const upper = await searchKeyword(projectID, "STORAGE", { limit: 5 });

    expect(lower.length).toEqual(upper.length);
  });

  test("respects limit parameter", async () => {
    const projectID = await getCurrentProjectID();
    const results = await searchKeyword(projectID, "the", { limit: 10 });

    expect(results.length).toBeLessThanOrEqual(10);
  });
});
