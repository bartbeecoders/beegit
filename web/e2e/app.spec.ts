// Works against any repository: it navigates by what the UI lists, not by fixed paths.
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";

function token(): string {
  if (process.env.BEEGIT_E2E_TOKEN) return process.env.BEEGIT_E2E_TOKEN;
  const file = process.env.BEEGIT_E2E_CREDENTIALS ?? `${os.homedir()}/.config/beegit/credentials`;
  const m = /^token\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(file, "utf8"));
  if (!m) throw new Error(`no token in ${file}`);
  return m[1];
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("BeeGit token").fill(token());
  await page.getByRole("button", { name: "Use token" }).click();
  await expect(page).toHaveURL(/\/$/);
}

const consoleErrors = (page: Page) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  return errors;
};

test("signed-out visitors are sent to the sign-in page and back", async ({ page }) => {
  await page.goto("/r/x/log/main");
  await expect(page).toHaveURL(/\/login\?next=/);
  await expect(page.getByRole("heading", { name: "Sign in to BeeGit" })).toBeVisible();
});

test("a wrong token is rejected and nothing is stored", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("BeeGit token").fill("v4.public.not-a-token");
  await page.getByRole("button", { name: "Use token" }).click();
  await expect(page.locator(".error-inline")).toContainText(/unauthenticated/i);
  expect(await page.evaluate(() => sessionStorage.getItem("beegit.session"))).toBeNull();
});

test("browse, read, blame, history, changeset, refs, compare", async ({ page }) => {
  const errors = consoleErrors(page);
  await signIn(page);

  // Repositories → repository home.
  const card = page.locator(".repo-card").first();
  await expect(card).toBeVisible();
  const repo = (await card.locator("strong").first().textContent())!.trim();
  await card.click();
  await expect(page).toHaveURL(new RegExp(`/r/${repo}/tree/main$`));
  await expect(page.locator(".last-change")).toBeVisible();

  // A directory, then a file in the tree.
  const dir = page.locator(".file-row a").filter({ hasNotText: ".." }).first();
  const firstEntry = await page.locator(".file-row a").first().getAttribute("href");
  if (firstEntry?.includes("/tree/")) {
    await dir.click();
    await expect(page.locator(".crumbs strong")).toBeVisible();
  }
  const file = page.locator('.file-row a[href*="/blob/"]').first();
  await expect(file).toBeVisible();
  await file.click();
  await expect(page).toHaveURL(/\/blob\//);
  await expect(page.locator(".file-bar")).toBeVisible();
  await expect(page.locator(".code-line, .markdown, .empty, .image-view").first()).toBeVisible();

  // Line anchors select lines.
  if (await page.locator(".code-line").count()) {
    await page.locator(".code-line .ln").first().click();
    await expect(page).toHaveURL(/#L1$/);
    await expect(page.locator(".code-line.sel")).toHaveCount(1);
  }

  // Blame of that file.
  await page.getByRole("link", { name: "Blame" }).click();
  await expect(page.locator(".blame-range").first()).toBeVisible();
  await expect(page.locator(".blame-info a").first()).toBeVisible();

  // History → a changeset with its diff, in both layouts.
  await page.getByRole("link", { name: "History", exact: true }).first().click();
  await expect(page.locator(".change-row").first()).toBeVisible();
  await page.locator(".change-title").first().click();
  await expect(page).toHaveURL(/\/c\/c1[0-9a-f]{64}$/);
  await expect(page.locator(".change-card .kv")).toBeVisible();
  await expect(page.getByText(/files? changed|No file changes/)).toBeVisible();
  if (await page.locator(".diff-file").count()) {
    await page.getByRole("button", { name: "Split" }).click();
    await expect(page.locator("table.diff.split").first()).toBeVisible();
    await page.getByRole("button", { name: "Unified" }).click();
    await expect(page.locator("table.diff.unified").first()).toBeVisible();
  }

  // Refs and a ref log.
  await page.getByRole("link", { name: "Refs", exact: true }).click();
  await expect(page.locator("table.table").getByRole("link", { name: "main", exact: true })).toBeVisible();
  await page.locator('table.table a[href*="/refs/"]').first().click();
  await expect(page.locator(".change-row").first()).toBeVisible();

  // Compare a revision with itself.
  await page.goto(`/r/${repo}/compare/main...main`);
  await expect(page.getByText(/identical revisions|No differences/).first()).toBeVisible();

  // The revision picker resolves the CLI grammar.
  await page.goto(`/r/${repo}/tree/main`);
  await page.getByLabel("Revision").fill("main~0");
  await page.getByLabel("Revision").press("Enter");
  await expect(page).toHaveURL(/\/tree\/main~0$/);
  await expect(page.locator(".last-change")).toBeVisible();

  expect(errors).toEqual([]);
});

test("unknown revisions and repositories say so", async ({ page }) => {
  await signIn(page);
  const repo = (await page.locator(".repo-card strong").first().textContent())!.trim();
  await page.goto(`/r/${repo}/tree/no-such-ref-xyz`);
  await expect(page.getByText("Unknown revision no-such-ref-xyz")).toBeVisible();
  await page.goto("/r/no-such-repo/tree/main");
  await expect(page.getByRole("heading", { name: "Repository not found" })).toBeVisible();
});

test("dark theme and phone width", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.locator(".repo-card").first().click();
  await expect(page.locator(".files")).toBeVisible();
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(20, 19, 15)");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});
