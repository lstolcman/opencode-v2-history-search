import { test, expect, describe } from "bun:test";
import historySearch from "./index";

describe("historySearch tool", () => {
  test("exports a tool with a description", () => {
    expect(historySearch).toBeDefined();
    expect(typeof historySearch).toBe("object");
  });

  test("tool schema includes terms parameter for multi-term search", () => {
    const description = (historySearch as any).description ?? "";
    const args = (historySearch as any).args ?? {};
    expect(args).toHaveProperty("terms");
  });
});

describe("OpenCode V2 setup", () => {
  async function register(): Promise<any> {
    let added: any;
    const ctx = {
      tool: {
        transform: async (callback: (editor: { add: (tool: any) => void }) => void) => {
          callback({
            add: (tool) => {
              added = tool;
            },
          });
        },
      },
    };

    await (historySearch as any).setup(ctx);
    return added;
  }

  test("registers the history-search tool through ctx.tool.transform", async () => {
    const added = await register();

    expect(added).toBeDefined();
    expect(added.name).toBe("history-search");
    expect(added.description).toContain("conversation histories");
    expect(added.input).toBeDefined();
    expect(typeof added.execute).toBe("function");
  });

  test("adapts the V1 string result to the V2 tool result shape", async () => {
    const added = await register();
    const originalExecute = (historySearch as any).execute;

    try {
      (historySearch as any).execute = async () => "search output";
      const result = await added.execute(
        { query: "storage" },
        { signal: new AbortController().signal },
      );

      expect(result).toEqual({ content: "search output" });
    } finally {
      (historySearch as any).execute = originalExecute;
    }
  });

  test("is a no-op when the host has no tool domain", async () => {
    await expect((historySearch as any).setup({})).resolves.toBeUndefined();
  });
});
