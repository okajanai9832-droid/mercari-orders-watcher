// src/index.js
// メルカリ注文ウォッチャー (並列処理版)
// 商品レベルで同時5件まで並列実行

import {
  ensureSheets,
  loadTargetOrders,
  loadVariationsCache,
  appendVariationCache,
  loadSeenIds,
  saveSeenIds,
} from './sheets.js';
import { searchMercariMulti } from './mercari.js';
import { sendDiscordNotification } from './discord.js';
import {
  buildSearchQueries,
  generateVariations,
  isMatch,
} from './keywords.js';

// 同時実行数 (5並列)
const CONCURRENCY = 5;

async function main() {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] 起動`);

  await ensureSheets();

  const orders = await loadTargetOrders();
  console.log(`検索対象注文: ${orders.length}件`);
  if (orders.length === 0) {
    console.log('対象なし。終了。');
    return;
  }

  const variationsCache = await loadVariationsCache();
  const seenIds = await loadSeenIds();
  console.log(`揺らぎキャッシュ: ${variationsCache.size}件 / 通知済み: ${seenIds.size}件`);

  const uniqueOrders = dedupeByProductName(orders);
  console.log(`ユニーク商品: ${uniqueOrders.length}件 (並列${CONCURRENCY}件で実行)`);

  // 揺らぎ生成 (新規分のみ事前にまとめてやる)
  for (const order of uniqueOrders) {
    if (!variationsCache.has(order.productName)) {
      const variations = generateVariations(order.productName);
      await appendVariationCache(order.productName, variations);
      variationsCache.set(order.productName, variations);
      console.log(`[新規揺らぎ生成] "${order.productName}" → [${variations.join(', ')}]`);
    }
  }

  // 並列実行: バッチ処理
  const newSeenIds = new Set(seenIds);
  let totalNotify = 0;
  const allHits = [];

  for (let i = 0; i < uniqueOrders.length; i += CONCURRENCY) {
    const batch = uniqueOrders.slice(i, i + CONCURRENCY);
    console.log(`\n--- バッチ ${Math.floor(i / CONCURRENCY) + 1}: ${batch.length}件並列 ---`);

    const results = await Promise.all(
      batch.map(order => searchOneOrder(order, variationsCache, seenIds))
    );

    for (const r of results) {
      if (r.items.length > 0) {
        allHits.push(r);
      }
    }
  }

  // 通知は直列で (Discord レート制限対策)
  console.log(`\n--- 通知フェーズ: ${allHits.length}商品にヒットあり ---`);
  for (const { order, items } of allHits) {
    for (const item of items) {
      if (newSeenIds.has(item.id)) continue;
      await sendDiscordNotification(item, order);
      newSeenIds.add(item.id);
      totalNotify++;
      await sleep(1100);
    }
  }

  await saveSeenIds(Array.from(newSeenIds));

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n[完了] 通知: ${totalNotify}件 / 実行時間: ${elapsed}秒`);
}

async function searchOneOrder(order, variationsCache, seenIds) {
  try {
    const variations = variationsCache.get(order.productName) || [];
    const queries = buildSearchQueries(order.productName, variations);
    console.log(`[検索開始] "${order.productName}" 上限¥${order.netRevenue.toLocaleString()} (${queries.length}クエリ)`);

    const items = await searchMercariMulti(queries, order.netRevenue);
    const matched = items.filter(item =>
      isMatch(item.title, order.productName, variations)
    );
    const newItems = matched.filter(item => !seenIds.has(item.id));

    console.log(`[検索完了] "${order.productName}" 取得${items.length}/マッチ${matched.length}/新着${newItems.length}`);
    return { order, items: newItems };
  } catch (err) {
    console.error(`[エラー] "${order.productName}":`, err.message);
    return { order, items: [] };
  }
}

function dedupeByProductName(orders) {
  const map = new Map();
  for (const order of orders) {
    const key = order.productName;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, order);
      continue;
    }
    const existingDate = new Date(existing.shipDueDate).getTime() || Infinity;
    const newDate = new Date(order.shipDueDate).getTime() || Infinity;
    if (newDate < existingDate) {
      map.set(key, order);
    }
  }
  return Array.from(map.values());
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(err => {
  console.error('致命的エラー:', err);
  process.exit(1);
});
