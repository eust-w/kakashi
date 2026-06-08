import { describe, expect, it } from "vitest";
import { createRunId, slugify, stableId } from "./ids";

describe("id helpers", () => {
  it("creates run ids, stable hashes, and path-safe slugs", () => {
    expect(createRunId()).toMatch(/^run_\d{14}_[0-9a-f-]{8}$/);
    expect(stableId("same input")).toBe(stableId("same input"));
    expect(stableId("same input")).not.toBe(stableId("different input"));
    expect(slugify("Owner/Repo Name!")).toBe("owner-repo-name");
    expect(slugify("!!!")).toBe(stableId("!!!"));
  });
});
