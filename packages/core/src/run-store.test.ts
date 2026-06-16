import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { RunStore } from "./run-store";

describe("RunStore", () => {
  it("persists state and append-only events", async () => {
    const root = await mkdtemp(join(tmpdir(), "kakashi-runs-"));
    const store = new RunStore(root);
    const state = await store.create("auto", "build a cli", join(root, "out"));
    await store.appendEvent(state.runId, "searching", "info", "Searching");

    const loaded = await store.load(state.runId);
    const events = await store.events(state.runId);

    expect(loaded?.requirementText).toBe("build a cli");
    expect(events.map((event) => event.message)).toContain("Searching");
  });

  it("returns empty collections for missing state and sorts persisted runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "kakashi-runs-"));
    const store = new RunStore(root);

    await expect(store.load("missing")).resolves.toBeNull();
    await expect(store.events("missing")).resolves.toEqual([]);

    const first = await store.create("auto", "first", join(root, "first-out"));
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await store.create("interactive", "second", join(root, "second-out"));
    const listed = await store.list();

    expect(listed.map((state) => state.runId)).toEqual([second.runId, first.runId]);
    expect(listed[0]?.mode).toBe("interactive");
  });

  it("redacts event data before writing JSONL", async () => {
    const root = await mkdtemp(join(tmpdir(), "kakashi-runs-"));
    const store = new RunStore(root);
    const state = await store.create("auto", "secret handling", join(root, "out"));

    await store.appendEvent(state.runId, "searching", "info", "Authenticated", {
      token: "ghp_123456789012345678901234567890"
    });

    const events = await store.events(state.runId);
    expect(JSON.stringify(events)).toContain("[REDACTED]");
    expect(JSON.stringify(events)).not.toContain("ghp_123456789012345678901234567890");
  });

  it("keeps stored run stages aligned with lifecycle events without mutating terminal states", async () => {
    const root = await mkdtemp(join(tmpdir(), "kakashi-runs-"));
    const store = new RunStore(root);
    const state = await store.create("auto", "live stage tracking", join(root, "out"));

    await store.appendEvent(state.runId, "searching", "info", "Searching");
    await expect(store.load(state.runId)).resolves.toMatchObject({ stage: "searching" });

    const completed = { ...(await store.load(state.runId))!, stage: "completed" as const };
    await store.save(completed);
    await store.appendEvent(state.runId, "failed", "error", "Late failure event");

    await expect(store.load(state.runId)).resolves.toMatchObject({ stage: "completed" });
  });

  it("rejects run ids that would escape the run store directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "kakashi-runs-"));
    const store = new RunStore(root);
    const externalStatePath = join(root, "..", "outside-run", "state.json");
    await mkdir(dirname(externalStatePath), { recursive: true });
    await writeFile(
      externalStatePath,
      JSON.stringify({
        runId: "outside-run",
        mode: "auto",
        stage: "completed",
        requirementText: "outside",
        outputDir: root,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }),
      "utf8"
    );

    await expect(store.load("../outside-run")).rejects.toThrow(/Invalid run id/);
    await expect(store.events("../outside-run")).rejects.toThrow(/Invalid run id/);
    await expect(store.appendEvent("../outside-run", "searching", "info", "outside")).rejects.toThrow(/Invalid run id/);
  });
});
