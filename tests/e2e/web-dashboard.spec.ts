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
