import { expect, test } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

test("dashboard connects to the real API server and validates run controls", async ({ page, request }) => {
  const health = await request.get("/health");
  expect(health.ok()).toBe(true);
  expect(await health.json()).toEqual({ ok: true, service: "kakashi-server" });

  const runs = await request.get("/api/runs");
  expect(runs.ok()).toBe(true);
  expect(await runs.json()).toEqual(expect.any(Array));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Kakashi", exact: true })).toBeVisible();
  await expect(page.getByLabel("Requirement")).toBeVisible();
  await expect(page.getByRole("button", { name: /Start run/ })).toBeDisabled();
  await expect(page.getByLabel("Max repositories")).toHaveValue("12");
  await expect(page.getByLabel("Repair iterations")).toHaveValue("3");
  await expect(page.getByLabel("Allow copyleft")).not.toBeChecked();
  await expect(page.getByLabel("Overwrite output")).not.toBeChecked();

  await page.getByRole("button", { name: /Interactive/ }).click();
  await expect(page.getByRole("button", { name: /Interactive/ })).toHaveClass(/selected/);

  await page.getByLabel("Max repositories").fill("6");
  await page.getByLabel("Repair iterations").fill("2");
  await page.getByLabel("Allow copyleft").check();
  await page.getByLabel("Overwrite output").check();
  await page.getByLabel("Output directory").fill("kakashi-e2e-dashboard");
  await page.getByLabel("Requirement").fill("Build a TypeScript CLI with GitHub repository search");
  await expect(page.getByRole("button", { name: /Start run/ })).toBeEnabled();
});

test("interactive dashboard replans from selected repositories before execution", async ({ page, request }) => {
  const serverWorkDir = join(process.cwd(), "apps", "server");
  const state = interactiveRunState(`run_e2e_selection_${Date.now()}`, serverWorkDir);
  const statePath = join(serverWorkDir, ".kakashi", "runs", state.runId, "state.json");
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  try {
    await page.goto("/");
    await page.getByRole("button", { name: new RegExp(state.requirementText) }).click();

    await expect(page.getByRole("link", { name: "open-source/primary" })).toBeVisible();
    await expect(page.getByRole("link", { name: "open-source/auxiliary" })).toBeVisible();
    await expect(page.getByText(/Main:/)).toContainText("open-source/primary");

    await page.getByLabel("Use open-source/primary").uncheck();
    await page.getByLabel("Use open-source/auxiliary").check();
    await page.getByRole("button", { name: /Update plan/ }).click();

    await expect(page.getByText(/Main:/)).toContainText("open-source/auxiliary");
    const response = await request.get(`/api/runs/${state.runId}`);
    expect(response.ok()).toBe(true);
    const updated = (await response.json()) as { plan?: { main?: { repo?: { fullName?: string } } } };
    expect(updated.plan?.main?.repo?.fullName).toBe("open-source/auxiliary");
  } finally {
    await rm(join(serverWorkDir, ".kakashi", "runs", state.runId), { recursive: true, force: true });
  }
});

function interactiveRunState(runId: string, workDir: string) {
  const now = new Date().toISOString();
  const requirement = {
    raw: "Build a searchable developer tool",
    goal: "Build a searchable developer tool",
    target: "web",
    preferredStack: ["TypeScript"],
    constraints: [],
    capabilities: [
      {
        id: "search",
        name: "Repository Search",
        description: "Search and rank repository content",
        keywords: ["search", "rank"],
        required: true
      }
    ]
  };
  const primary = repoAnalysis("open-source/primary", 1, "search", 0.92);
  const auxiliary = repoAnalysis("open-source/auxiliary", 2, "search", 0.84);
  const graph = {
    capabilities: requirement.capabilities,
    repos: [primary],
    edges: [
      {
        capabilityId: "search",
        repoFullName: primary.candidate.fullName,
        confidence: 0.92,
        evidence: [`${primary.candidate.fullName} implements search`]
      }
    ],
    gaps: []
  };
  return {
    runId,
    mode: "interactive",
    stage: "waiting_for_confirmation",
    requirementText: requirement.raw,
    outputDir: resolve(workDir, ".kakashi", "e2e-selection-output"),
    createdAt: now,
    updatedAt: now,
    spec: requirement,
    candidates: [primary.candidate, auxiliary.candidate],
    analyses: [primary, auxiliary],
    graph,
    plan: {
      requirement,
      graph,
      main: {
        role: "main",
        repo: primary.candidate,
        localPath: primary.localPath,
        providedCapabilities: ["search"],
        rationale: "Initial fixture plan."
      },
      auxiliaries: [],
      tasks: [
        {
          title: "Fuse selected repository capability",
          prompt: "Use the selected repository capability in the target project.",
          successCriteria: ["The selected repository is reflected in the fusion plan."]
        }
      ],
      verifierCommands: [],
      outputDir: resolve(workDir, ".kakashi", "e2e-selection-output"),
      createdAt: now
    }
  };
}

function repoAnalysis(fullName: string, id: number, capabilityId: string, confidence: number) {
  const candidate = repoCandidate(fullName, id);
  return {
    candidate,
    localPath: resolve(process.cwd(), ".kakashi", "sources", candidate.name),
    stack: ["TypeScript"],
    packageManagers: ["pnpm"],
    manifests: ["package.json"],
    commands: [
      {
        name: "test",
        command: "pnpm test",
        source: "package.json",
        purpose: "test"
      }
    ],
    modules: [
      {
        path: "src/index.ts",
        kind: "source",
        summary: "Core implementation"
      }
    ],
    readmeSummary: `${fullName} README summary`,
    capabilityMatches: [
      {
        capabilityId,
        capabilityName: "Repository Search",
        confidence,
        evidence: [`${fullName} implements search`]
      }
    ],
    risks: []
  };
}

function repoCandidate(fullName: string, id: number) {
  const [owner, name] = fullName.split("/");
  return {
    id,
    fullName,
    owner: owner ?? "open-source",
    name: name ?? fullName,
    htmlUrl: `https://github.com/${fullName}`,
    cloneUrl: `https://github.com/${fullName}.git`,
    defaultBranch: "main",
    description: `${fullName} description`,
    stars: id * 100,
    forks: id * 10,
    openIssues: 0,
    language: "TypeScript",
    license: "MIT",
    updatedAt: "2026-06-17T00:00:00.000Z",
    pushedAt: "2026-06-17T00:00:00.000Z",
    archived: false,
    fork: false,
    score: 1,
    matchedCapabilities: ["search"]
  };
}
