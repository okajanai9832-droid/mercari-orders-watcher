// src/mercari.js
// メルカリ検索 (Stealth強化版)
// playwright-extra + stealth plugin で Bot検出を回避

import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Stealth pluginを有効化 (navigator.webdriver, plugins, languages 等を偽装)
chromiumExtra.use(StealthPlugin());

// 最新の実Chromeに近いUA
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
      // 日本のユーザーらしく見せる
      extraHTTPHeaders: {
        'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      },
    });

    // navigator系のフィンガープリント偽装
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
        // 人間らしい間隔 (1.5〜3秒のランダム)
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
    // Refererを設定して自然なナビゲーションに見せる
    await page.setExtraHTTPHeaders({
      'Referer': 'https://jp.mercari.com/',
    });

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // 商品リンクが描画されるまで最大15秒待つ
    await page.waitForSelector('a[href*="/item/"]', { timeout: 15000 }).catch(() => {});

    // 少し追加で待機 (動的描画の遅延を吸収)
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
