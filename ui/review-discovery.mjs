// Optional bounded visual check. Run only against the ignored synthetic demo on port 4328.
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve('.impeccable/review');
await fs.mkdir(root, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const report = [];
try {
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4328');
    await page.getByRole('button', { name: 'View Sample: Stillwater' }).waitFor();
    if (name === 'desktop') {
      await page.getByRole('button', { name: 'View Sample: Stillwater' }).click();
      await page.getByRole('complementary').waitFor();
      await page.screenshot({ path: path.join(root, 'desktop-library.png'), fullPage: true });
      await page.getByRole('button', { name: 'Discover', exact: true }).click();
    } else await page.getByLabel('View', { exact: true }).selectOption('__discover');
    await page.getByLabel('Reference playlist').selectOption('pl_demo');
    await page.getByLabel('What are you looking for?').fill('Quieter landscape scenes for evening, with very little movement.');
    await page.getByRole('button', { name: 'Find wallpapers' }).click();
    await page.getByRole('link', { name: 'Open Steam search' }).waitFor();
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(root, `${name}.png`), fullPage: true });
    report.push({ viewport: name, overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      steamSearch: await page.getByRole('link', { name: 'Open Steam search' }).getAttribute('href'), errors });
    // Explicitly synthetic browser fixtures exercise populated layout without contacting Steam.
    const candidate = { id: '22', title: 'Sample: Quiet forest candidate', summary: 'Synthetic review metadata', tags: ['Landscape'],
      previewUrl: '/api/wallpapers/wp_demo3/preview', steamUrl: 'https://steamcommunity.com/sharedfiles/filedetails/?id=22', source: 'steam-workshop', appId: 431960,
      match: { explicitQueryTerms: ['quiet'], referenceTags: ['landscape'], explanation: 'Synthetic title/tag evidence for visual review.' } };
    await page.route('**/api/inspect', route => route.fulfill({ json: { status: 'available', candidate, installed: false, dismissed: false } }));
    await page.route('**/api/shortlist?*', route => route.fulfill({ json: { details: [{ id: '22', status: 'available', candidate }], pagination: { offset: 0, total: 1, nextOffset: null } } }));
    await page.getByLabel('Workshop URL or ID').fill('22'); await page.getByRole('button', { name: 'Inspect item', exact: true }).click();
    await page.getByRole('heading', { name: candidate.title }).waitFor();
    if (await page.getByRole('button', { name: 'Shortlist', exact: true }).count()) await page.getByRole('button', { name: 'Shortlist', exact: true }).click();
    await page.getByRole('button', { name: 'Show shortlist' }).click(); await page.getByText('Showing 1–1 of 1 saved items.').waitFor();
    await page.evaluate(async () => { await Promise.all([...document.images].map(image => image.decode().catch(() => {}))); scrollTo(0, 0); });
    await page.screenshot({ path: path.join(root, `${name}-populated.png`), fullPage: true });
    report.push({ viewport: `${name}-populated`, syntheticBrowserFixtures: true, overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), errors });
    await page.close();
  }
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
