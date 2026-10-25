#!/usr/bin/env node
// Screenshots of the local key-journey dashboard for _docs/observability.md (#32).
//
//   make up                     # then put some traffic through the app
//   make install                # Playwright comes with the frontend dev dependencies
//   node scripts/grafana_screenshots.mjs [<grafana url>]
//
// Writes _docs/images/observability/{key-journey-saves-history,key-journey-errors-http,
// error-log-to-trace}.png from the last 15 minutes. The default Grafana URL is
// http://localhost:$GRAFANA_PORT (3000). The last image follows the first trace_id link
// of "Error logs with their traces", so the window needs at least one error log line
// from a request (stopping Postgres for a few seconds under traffic gives some).
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repo, "frontend", "package.json"));
const { chromium } = require("@playwright/test");

const grafana = process.argv[2] ?? `http://localhost:${process.env.GRAFANA_PORT ?? "3000"}`;
const out = path.join(repo, "_docs", "images", "observability");
const dashboard = `${grafana}/d/focus-key-journey-local?orgId=1&from=now-15m&to=now&kiosk&theme=light`;

const browser = await chromium.launch();
try {
  // Tall enough that every panel renders (Grafana only loads panels in view).
  const page = await browser.newPage({ viewport: { width: 1600, height: 2600 } });
  await page.goto(dashboard, { waitUntil: "networkidle" });
  await page.waitForTimeout(8000);
  const split = await page.getByText("Errors, logs and traces", { exact: true }).boundingBox();
  const last = await page.getByText("p95 latency, key-journey routes", { exact: true }).boundingBox();
  if (!split || !last) throw new Error(`the dashboard did not render: ${dashboard}`);
  const top = Math.floor(split.y) - 8;
  await page.screenshot({
    path: path.join(out, "key-journey-saves-history.png"),
    clip: { x: 0, y: 0, width: 1600, height: top },
  });
  await page.screenshot({
    path: path.join(out, "key-journey-errors-http.png"),
    clip: { x: 0, y: top, width: 1600, height: Math.ceil(last.y) + 230 - top },
  });

  await page.getByText(/^[0-9a-f]{32}$/).first().click();
  const href = await page.locator('a[href*="schemaVersion"]').first().getAttribute("href", { timeout: 5000 });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`${new URL(href, grafana)}&theme=light`, { waitUntil: "networkidle" });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(out, "error-log-to-trace.png") });
  console.log(`wrote ${path.relative(repo, out)}/*.png`);
} finally {
  await browser.close();
}
