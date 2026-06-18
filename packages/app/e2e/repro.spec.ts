import { test, expect } from '@playwright/test';

test('repro stack overflow new session', async ({ page }) => {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('CONSOLE ERROR', msg.text());
  });
  page.on('pageerror', (err) => {
    console.log('PAGEERROR', err.message);
    console.log(err.stack);
  });
  page.on('response', (res) => {
    const url = res.url();
    if (url.includes('/api/session/') || url.includes('/session/')) {
      if (res.request().method() === 'POST' || res.request().method() === 'GET') {
        console.log('RESPONSE', res.status(), res.request().method(), url);
      }
    }
  });
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (url.includes('/api/session/') || url.includes('/session/')) {
      console.log('REQ_FAIL', url, req.failure()?.errorText);
    }
  });

  const encoded = Buffer.from('/Users/zexi/workspace', 'utf8').toString('base64');
  await page.goto(`http://127.0.0.1:3000/${encoded}/session`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  await page.waitForTimeout(3000);

  const editor = page.locator('[contenteditable="true"]').first();
  const count = await editor.count();
  console.log('contenteditable count', count);
  if (count === 0) {
    await expect(editor).toHaveCount(1, { timeout: 30000 });
  }

  await editor.click({ timeout: 30000 });
  await editor.fill('hello from test');

  const submit = page.locator('[data-action="prompt-submit"]').first();
  console.log('submit disabled?', await submit.isDisabled());
  await submit.click({ timeout: 30000, force: true });
  await page.waitForTimeout(1000);
  console.log('url after submit', page.url());

  await page.waitForTimeout(8000);
  const errorLocator = page.locator('text=Maximum call stack size exceeded');
  const errors = await errorLocator.count();
  console.log('stack error text count', errors);

  await page.waitForTimeout(8000);
});
