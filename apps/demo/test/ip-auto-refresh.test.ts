import { readFile } from 'node:fs/promises';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser, page: Page;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.clock.install();
});
afterAll(async () => { await browser?.close(); });
it('refreshes automatically, shows an IP change, and backs off after rate limiting', async () => {
  let requests = 0;
  await page.route('https://ipinfo.io/json', route => {
    requests++;
    return route.fulfill(requests === 3
      ? { status: 429, body: '{}' }
      : { contentType: 'application/json', body: JSON.stringify({ ip: requests === 1 ? '192.0.2.1' : '192.0.2.2' }) });
  });
  await page.setContent(await readFile(new URL('../../../website/ip-check/index.html', import.meta.url), 'utf8'));
  await page.waitForFunction(() => document.getElementById('ip')?.textContent === '192.0.2.1');
  await page.getByRole('button', { name: 'Use as baseline' }).click();
  await page.clock.runFor(15000);
  await page.waitForFunction(() => document.getElementById('ip')?.textContent === '192.0.2.2');
  expect(await page.locator('#status').innerText()).toContain('IP changed');
  await page.clock.runFor(15000);
  await page.waitForFunction(() => !document.getElementById('error')?.hidden);
  await page.clock.runFor(45000);
  expect(requests).toBe(3);
  await page.clock.runFor(15000);
  await page.waitForFunction(() => document.getElementById('error')?.hidden);
  expect(requests).toBe(4);
});
