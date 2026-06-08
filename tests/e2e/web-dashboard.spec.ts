import { expect, test } from "@playwright/test";

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

  await page.getByRole("button", { name: /Interactive/ }).click();
  await expect(page.getByRole("button", { name: /Interactive/ })).toHaveClass(/selected/);

  await page.getByLabel("Output directory").fill("/tmp/kakashi-e2e-dashboard");
  await page.getByLabel("Requirement").fill("Build a TypeScript CLI with GitHub repository search");
  await expect(page.getByRole("button", { name: /Start run/ })).toBeEnabled();
});
