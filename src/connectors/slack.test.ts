import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SlackExportConnector } from "./slack.js";

const FIXTURE = join(process.cwd(), "examples", "slack-export-tiny");

async function collect(path: string) {
  const c = new SlackExportConnector({ path });
  const out = [];
  for await (const m of c.fetch()) out.push(m);
  return out;
}

describe("SlackExportConnector", () => {
  it("parses every channel in the fixture export", async () => {
    const messages = await collect(FIXTURE);
    // 5 real msgs in #general (2 join/edit dropped, 1 bot kept), 2 in #design, 1 in leadership
    expect(messages.length).toBeGreaterThanOrEqual(8);
    const channels = new Set(messages.map((m) => m.channel));
    expect(channels.has("general")).toBe(true);
    expect(channels.has("design")).toBe(true);
  });

  it("drops system noise (channel_join, message_changed)", async () => {
    const messages = await collect(FIXTURE);
    // Original msg-002 ts is 1741006920.000200; the message_changed event also
    // carries that ts but with subtype "message_changed". After dedup-by-id we
    // should still have exactly one message at that ts.
    const targets = messages.filter((m) => m.sourceId === "1741006920.000200");
    expect(targets.length).toBe(1);
    // Join messages have no real text and should be skipped entirely.
    expect(messages.some((m) => /has joined the channel/i.test(m.body))).toBe(false);
  });

  it("renders user mentions as display names", async () => {
    const messages = await collect(FIXTURE);
    const reply = messages.find((m) => /two questions for/i.test(m.body));
    expect(reply).toBeDefined();
    expect(reply?.body).toContain("@Ana");
    expect(reply?.body).not.toMatch(/<@U001>/);
  });

  it("renders channel mentions and entity-decoded text", async () => {
    const messages = await collect(FIXTURE);
    const announce = messages.find((m) => m.body.includes("locking Q3 pricing"));
    expect(announce).toBeDefined();
    expect(announce?.body).toContain("#general");
    expect(announce?.body).not.toMatch(/<#C001\|general>/);

    // The entity-encoded apostrophe (`Don&#39;t`) should be decoded.
    const lockedReply = messages.find((m) => m.body.includes("Edu/nonprofit"));
    expect(lockedReply?.body).toContain("Don't");
  });

  it("renders link markup and broadcast subtype", async () => {
    const messages = await collect(FIXTURE);
    const figma = messages.find((m) => m.body.includes("Figma"));
    expect(figma?.body).toContain("https://figma.com/file/onboarding-v3");
    expect(figma?.body).toContain("[file: Onboarding v3]");
    expect(figma?.body).toContain("@channel");

    const bot = messages.find((m) => m.body.includes("PR opened"));
    expect(bot?.from.name).toBe("GitHub");
    expect(bot?.body).toContain("Update Stripe price ids for Q3 launch (https://github.com/flowdesktech/flowdesk/pull/4821)");
  });

  it("groups thread replies under a single threadId", async () => {
    const messages = await collect(FIXTURE);
    // The announcement is msg-001 in the fixture (parent of the pricing thread).
    const parent = messages.find((m) => m.sourceId === "1740999900.000100");
    expect(parent).toBeDefined();
    // msg-002, msg-003, msg-006 all reply under thread_ts == parent.ts.
    const inThread = messages.filter((m) => m.threadId === parent?.threadId);
    expect(inThread.length).toBeGreaterThanOrEqual(4);
    // Parent's threadId should equal slack:T999:C001:<parent.ts>
    expect(parent?.threadId).toBe(`slack:T999:C001:1740999900.000100`);
  });

  it("respects the `since` filter", async () => {
    // Pick a cutoff just after the first message; everything before should drop.
    const cutoff = new Date("2026-03-04T00:00:00Z").getTime();
    const c = new SlackExportConnector({ path: FIXTURE });
    const messages = [];
    for await (const m of c.fetch({ since: cutoff })) messages.push(m);
    expect(messages.every((m) => m.timestamp >= cutoff)).toBe(true);
    // The very first general post (March 3) must be excluded.
    expect(messages.some((m) => m.sourceId === "1740999900.000100")).toBe(false);
  });

  it("rejects a non-slack directory with a useful error", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mneme-slack-bad-"));
    writeFileSync(join(tmp, "stray.txt"), "hello");
    const c = new SlackExportConnector({ path: tmp });
    try {
      await expect(async () => {
        for await (const _ of c.fetch()) {
          // unreachable
        }
      }).rejects.toThrow(/users\.json/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a zip file with extraction guidance", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mneme-slack-zip-"));
    const zipPath = join(tmp, "slack-export.zip");
    writeFileSync(zipPath, "not really a zip");
    const c = new SlackExportConnector({ path: zipPath });
    try {
      await expect(async () => {
        for await (const _ of c.fetch()) {
          // unreachable
        }
      }).rejects.toThrow(/unzipped first/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
