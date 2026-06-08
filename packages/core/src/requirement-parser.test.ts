import { describe, expect, it } from "vitest";
import { RequirementParser } from "./requirement-parser";

describe("RequirementParser", () => {
  it("extracts target, stack, capabilities, and constraints from a mixed-language request", () => {
    const parser = new RequirementParser();
    const spec = parser.parse(
      "帮我做一个 React web dashboard，支持 GitHub 搜索、能力图谱、Codex 执行，不要mock和硬编码"
    );

    expect(spec.target).toBe("web");
    expect(spec.preferredStack).toContain("react");
    expect(spec.constraints).toContain("no mock, fake, simulated, or hardcoded success paths");
    expect(spec.capabilities.map((capability) => capability.name).join(" ")).toMatch(/GitHub|能力图谱|Codex/i);
  });

  it("rejects empty requirements", () => {
    const parser = new RequirementParser();
    expect(() => parser.parse("   ")).toThrow("Requirement cannot be empty");
  });
});

