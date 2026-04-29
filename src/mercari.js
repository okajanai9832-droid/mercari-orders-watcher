// src/mercari.js
// メルカリ検索 (Stealth + 価格抽出デバッグ強化版)

import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromiumExtra.use(StealthPlugin());

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.6778.205 Safari/537.36';

export async function searchMercariMulti(keywords, maxPrice) {
  const browser = await chromiumExtra.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--no-sandbox',
    ],
  });

  const allItems = new Map();

  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 768 },
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      extraHTTPHeaders: {
        'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      },
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['ja-JP', 'ja', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      window.chrome = { runtime: {} };
    });

    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    let firstQuery = true;
    for (const keyword of keywords) {
      try {
        const items = await searchOne(context, keyword, maxPrice, firstQuery);
        firstQuery = false;
        for (const item of items) {
          if (!allItems.has(item.id)) {
            allItems.set(item.id, item);
          }
        }
        const wait = 1500 + Math.random() * 1500;
        await new Promise(r => setTimeout(r, wait));
      } catch (err) {
        console.error(`  [検索エラー] "${keyword}":`, err.message);
      }
    }
  } finally {
    await browser.close();
  }

  return Array.from(allItems.values());
}

async function searchOne(context, keyword, maxPrice, debug = false) {
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
    await page.setExtraHTTPHeaders({
      'Referer': 'https://jp.mercari.com/',
    });

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('a[href*="/item/"]', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);

    if (debug) {
      const debugInfo = await page.evaluate(() => {
        return {
          title: document.title,
          htmlSize: document.documentElement.outerHTML.length,
          allLinks: document.querySelectorAll('a').length,
          itemLinksA: document.querySelectorAll('a[href^="/item/m"]').length,
          itemLinksB: document.querySelectorAll('a[href*="/item/"]').length,
          bodyStart: document.body.innerText.slice(0, 300),
        };
      });
      console.log(`  [DEBUG] URL: ${searchUrl}`);
      console.log(`  [DEBUG] title: ${debugInfo.title}`);
      console.log(`  [DEBUG] HTMLサイズ: ${debugInfo.htmlSize}`);
      console.log(`  [DEBUG] aタグ全数: ${debugInfo.allLinks}`);
      console.log(`  [DEBUG] /item/m リンク: ${debugInfo.itemLinksA}`);
      console.log(`  [DEBUG] /item/ リンク: ${debugInfo.itemLinksB}`);
      console.log(`  [DEBUG] body冒頭: ${debugInfo.bodyStart.slice(0, 150)}`);
    }

    const items = await page.evaluate(() => {
      let anchors = Array.from(document.querySelectorAll('a[href^="/item/m"]'));
      if (anchors.length === 0) {
        anchors = Array.from(document.querySelectorAll('a[href*="/item/"]'));
      }
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

        // 価格抽出: 複数パターン対応
        let price = 0;
        // パターン1: aria-label内の「1,500円」「¥1,500」
        const allText = ariaLabel + ' ' + innerText;
        const priceMatch1 = allText.match(/[¥￥]\s*([\d,]+)/);
        const priceMatch2 = allText.match(/([\d,]+)\s*円/);
        if (priceMatch1) {
          price = parseInt(priceMatch1[1].replace(/,/g, ''), 10);
        } else if (priceMatch2) {
          price = parseInt(priceMatch2[1].replace(/,/g, ''), 10);
        }
        // パターン3: 子要素のtextContentからも探す
        if (price === 0) {
          const allTextContent = a.textContent || '';
          const m3 = allTextContent.match(/[¥￥]\s*([\d,]+)/) || allTextContent.match(/([\d,]+)\s*円/);
          if (m3) {
            price = parseInt(m3[1].replace(/,/g, ''), 10);
          }
        }

        const img = a.querySelector('img');
        const imageUrl = img ? (img.getAttribute('src') || img.getAttribute('data-src') || '') : '';

        results.push({
          id,
          title: title.trim().slice(0, 100),
          price,
          imageUrl,
          url: `https://jp.mercari.com/item/${id}`,
          rawText: (ariaLabel + ' | ' + innerText).slice(0, 200), // デバッグ用
        });
      }
      return results;
    });

    // デバッグ: フィルタ前の取得内容を表示 (最初のクエリのみ)
    if (debug) {
      console.log(`  [DEBUG] フィルタ前 取得${items.length}件:`);
      items.slice(0, 5).forEach((item, i) => {
        console.log(`    ${i + 1}. id=${item.id} price=${item.price} title="${item.title.slice(0, 40)}"`);
        console.log(`       raw: ${item.rawText.slice(0, 100)}`);
      });
      const filtered = items.filter(it => it.price > 0 && it.price <= maxPrice);
      console.log(`  [DEBUG] フィルタ後: ${filtered.length}件 (price>0 かつ <=${maxPrice})`);
    }

    return items.filter(item => item.price > 0 && item.price <= maxPrice);

  } finally {
    await page.close();
  }
}
