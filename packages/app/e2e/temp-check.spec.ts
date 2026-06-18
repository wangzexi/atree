import { test } from '@playwright/test'

test('route main detail', async ({ page }) => {
  page.on('console', (msg) => console.log('console', msg.type(), msg.text()))
  await page.goto('/L1VzZXJzL3pleGkvd29ya3NwYWNl/session/ses_13f025258ffeKv1VMdcc9mlCRw')
  await page.waitForTimeout(2000)
  const info = await page.evaluate(() => {
    const main = document.querySelector('main')
    return {
      exists: !!main,
      childCount: main ? main.childElementCount : -1,
      children: main ? Array.from(main.children).map((c) => c.tagName.toLowerCase()) : [],
      innerHTML: main?.innerHTML.slice(0, 300),
      rootChildren: document.querySelector('#root')?.childElementCount ?? -1,
      rootInner: document.querySelector('#root')?.innerHTML.slice(0, 400),
      bodyText: document.body.innerText.slice(0, 400),
      routeType: window.location.pathname
    }
  })
  console.log(JSON.stringify(info, null, 2))
})
