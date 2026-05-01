import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MboxConnector } from "./mbox.js";

describe("MboxConnector", () => {
  it("parses the bundled sample mbox", async () => {
    const mboxPath = join(process.cwd(), "examples", "sample.mbox");
    const connector = new MboxConnector(mboxPath);
    const messages = [];
    for await (const m of connector.fetch()) {
      messages.push(m);
    }
    expect(messages.length).toBeGreaterThanOrEqual(6);

    const pricing = messages.find((m) => m.subject === "Q3 pricing decision");
    expect(pricing).toBeDefined();
    expect(pricing?.from.email).toBe("ana@flowdesk.tech");
    expect(pricing?.body).toContain("$19/month");
  });

  it("groups replies into the same thread", async () => {
    const mboxPath = join(process.cwd(), "examples", "sample.mbox");
    const connector = new MboxConnector(mboxPath);
    const threadIds = new Set<string>();
    const pricingMessages = [];
    for await (const m of connector.fetch()) {
      if (m.subject?.toLowerCase().includes("pricing")) {
        pricingMessages.push(m);
        if (m.threadId) threadIds.add(m.threadId);
      }
    }
    expect(pricingMessages.length).toBeGreaterThanOrEqual(4);
    // All pricing messages should resolve to a single thread root.
    expect(threadIds.size).toBe(1);
  });
});
