// src/mercari.js
// メルカリ検索スクレイパー (Playwright)

import { chromium } from 'playwright';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * メルカリで検索 (出品中・新着順・価格上限フィルタ)
 * @param {Array<string>} keywords - 検索クエリ配列
 * @param {number} maxPrice - 価格上限 (円)
 * @returns {Promise<Array<{id, title, price, imageUrl, url}>>}
 */
export async function searchMercariMulti(keywords, maxPrice) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const allItems = new Map(); // 重複排除のためMap (id → item)

  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 900 },
      locale: 'ja-JP',
    });

    // 静的リソースをブロックして高速化
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    for (const keyword of keywords) {
      try {
        const items = await searchOne(context, keyword, maxPrice);
        for (const item of items) {
          if (!allItems.has(item.id)) {
            allItems.set(item.id, item);
          }
        }
        // クエリ間スリープ (メルカリへの負荷軽減)
        await new Promise(r => setTimeout(r, 1500));
      } catch (err) {
        console.error(`  [検索エラー] "${keyword}":`, err.message);
      }
    }
  } finally {
    await browser.close();
  }

  return Array.from(allItems.values());
}

async function searchOne(context, keyword, maxPrice) {
  const params = new URLSearchParams({
    keyword: keyword,
    status: 'on_sale',
    sort: 'created_time',
    order: 'desc',
    price_max: String(maxPrice),
  });
  const searchUrl = `https://jp.mercari.com/search?${params.toString()}`;

  const page = await context.newPage();
  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('a[href^="/item/m"]', { timeout: 12000 }).catch(() => {});

    const items = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href^="/item/m"]'));
      const results = [];
      const seen = new Set();

      for (const a of anchors) {
        const href = a.getAttribute('href');
        const match = href.match(/\/item\/(m\d+)/);
        if (!match) continue;
        const id = match[1];
        if (seen.has(id)) continue;
        seen.add(id);

        const ariaLabel = a.getAttribute('aria-label') || '';
        const innerText = a.innerText || '';
        const title = ariaLabel || innerText.split('\n')[0] || '';

        let price = 0;
        const priceMatch = (ariaLabel + ' ' + innerText).match(/([\d,]+)\s*円/);
        if (priceMatch) {
          price = parseInt(priceMatch[1].replace(/,/g, ''), 10);
        }

        const img = a.querySelector('img');
        const imageUrl = img ? (img.getAttribute('src') || img.getAttribute('data-src') || '') : '';

        results.push({
          id,
          title: title.trim().slice(0, 100),
          price,
          imageUrl,
          url: `https://jp.mercari.com/item/${id}`,
        });
      }
      return results;
    });

    return items.filter(item => item.price > 0 && item.price <= maxPrice);

  } finally {
    await page.close();
  }
}
