// Local synthetic review only. Captures are ignored and never uploaded by this script.
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const root = new URL("../.impeccable/review/", import.meta.url);
await fs.mkdir(root, { recursive: true });
const report = [];
try {
  for (const [name, width, height] of [
    ["desktop", 1440, 1000],
    ["mobile", 390, 844],
  ]) {
    const page = await browser.newPage({
      viewport: { width, height },
      reducedMotion: "reduce",
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://127.0.0.1:4318");
    await page
      .getByRole("button", { name: "View Sample: Stillwater" })
      .waitFor();
    await page.evaluate(async () => {
      await Promise.all(
        [...document.images].map((image) => image.decode().catch(() => {})),
      );
    });
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({
      path: new URL(`${name}.png`, root).pathname.replace(/^\/(\w:)/, "$1"),
      fullPage: true,
    });
    report.push({
      viewport: name,
      overflow: await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      images: await page
        .locator("img")
        .evaluateAll((images) =>
          images.map((image) => ({
            loaded: image.complete && image.naturalWidth > 0,
          })),
        ),
      errors,
    });
    if (name === "desktop")
      await page
        .getByRole("button", { name: /Sample: Quiet evenings/ })
        .click();
    else await page.getByLabel("View", { exact: true }).selectOption("pl_demo");
    await page
      .getByRole("button", { name: "View Sample: Dusk ridge, entry 2" })
      .click();
    await page.getByRole("complementary").waitFor();
    await page.evaluate(async () => {
      await Promise.all(
        [...document.images].map((image) => image.decode().catch(() => {})),
      );
    });
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({
      path: new URL(`${name}-playlist.png`, root).pathname.replace(
        /^\/(\w:)/,
        "$1",
      ),
      fullPage: true,
    });
    report.push({
      viewport: `${name}-playlist`,
      overflow: await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      focusedDetails: await page
        .getByRole("complementary")
        .evaluate((element) => document.activeElement === element),
    });
    await page.close();
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
