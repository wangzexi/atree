import { test } from '@playwright/test';

test('log stack', async ({ page }) => {
  page.on('pageerror', (error) => {
    console.log('PAGEERR', error.message);
    console.log(error.stack);
  });
  page.on('console', (msg) => {
    console.log('CONSOLE', msg.type(), msg.text());
  });
  await page.goto('http://localhost:3000/');
  await page.waitForTimeout(2000);
});
