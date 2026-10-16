// End-to-end tests of the web UI against a running BeeGit (B-WEB-14).
//
//   BEEGIT_E2E_URL      the UI (default http://localhost:5173, i.e. `npm run dev`)
//   BEEGIT_E2E_TOKEN    a BeeGit token, or
//   BEEGIT_E2E_CREDENTIALS  a CLI credentials file to read it from
//                       (default ~/.config/beegit/credentials)
//   BEEGIT_E2E_CHROMIUM a Chromium binary (default /usr/bin/chromium when present,
//                       else Playwright's own browser: `npx playwright install chromium`)
import { defineConfig } from "@playwright/test";
import fs from "node:fs";

const chromium =
  process.env.BEEGIT_E2E_CHROMIUM ?? (fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BEEGIT_E2E_URL ?? "http://localhost:5173",
    viewport: { width: 1280, height: 900 },
    launchOptions: chromium ? { executablePath: chromium, args: ["--no-sandbox"] } : {},
    screenshot: "only-on-failure",
  },
});
