import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';

it('shows invalid budgets and rejected runs beside the controls without starting a payment', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const html = await readFile(new URL('../src/browser.html', import.meta.url), 'utf8');
    let runs = 0;
    await page.route('http://demo.test/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: html });
      if (path === '/api/status') return route.fulfill({ json: {
        running: false, modelReady: true, maximum: '0.05', model: 'test', payments: true,
        network: {}, expectedIp: '136.80.57.82',
      } });
      if (path === '/api/run') { runs++; return route.fulfill({ status: 409, json: { error: 'A run is already active' } }); }
      if (path === '/events') return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
      return route.fulfill({ status: 204 });
    });
    await page.goto('http://demo.test/');
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('#budget')?.max === '0.05');
    await page.locator('#budget').fill('0.1');
    await page.getByRole('button', { name: 'Run agent', exact: true }).click();
    expect(await page.locator('#error').innerText()).toBe('Set a budget between 0 and 0.05 RLUSD.');
    expect(await page.locator('#error').isVisible()).toBe(true);
    expect(runs).toBe(0);
    await page.locator('#budget').fill('0.05');
    await page.getByRole('button', { name: 'Run agent', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#error')?.textContent === 'A run is already active');
    expect(await page.locator('#error').isVisible()).toBe(true);
    expect(runs).toBe(1);
  } finally { await browser.close(); }
});
