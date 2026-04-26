// src/index.js
// メルカリ注文ウォッチャー メインエントリ
// orders シートから NEW/BUY_NG の注文を取得し、メルカリで仕入れ候補を検索 → Discord通知

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

async function main() {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] 起動`);

  // 0. 必要なシートが存在しない場合は作成
  await ensureSheets();

  // 1. 検索対象の注文を取得 (status: NEW or BUY_NG)
  const orders = await loadTargetOrders();
  console.log(`検索対象注文: ${orders.length}件`);

  if (orders.length === 0) {
    console.log('対象なし。終了。');
    return;
  }

  // 2. 揺らぎキャッシュ・通知済みIDを読み込み
  const variationsCache = await loadVariationsCache();
  const seenIds = await loadSeenIds();
  console.log(`揺らぎキャッシュ: ${variationsCache.size}件 / 通知済み: ${seenIds.size}件`);

  // 重複排除: 同じ product_name は1度だけ検索
  const uniqueOrders = dedupeByProductName(orders);
  console.log(`ユニーク商品: ${uniqueOrders.length}件`);

  const newSeenIds = new Set(seenIds);
  let totalNotify = 0;

  // 3. 商品ごとに検索 → 通知
  for (const order of uniqueOrders) {
    try {
      // 揺らぎキャッシュ確認 (なければ生成して保存)
      let variations = variationsCache.get(order.productName);
      if (variations === undefined) {
        variations = generateVariations(order.productName);
        await appendVariationCache(order.productName, variations);
        variationsCache.set(order.productName, variations);
        console.log(`  [新規揺らぎ生成] "${order.productName}" → [${variations.join(', ')}]`);
      }

      // 検索クエリ生成
      const queries = buildSearchQueries(order.productName, variations);
      console.log(`\n[検索] "${order.productName}" 上限¥${order.netRevenue.toLocaleString()}`);
      console.log(`  クエリ数: ${queries.length}件`);

      // メルカリ検索 (複数クエリを統合)
      const items = await searchMercariMulti(queries, order.netRevenue);
      console.log(`  取得: ${items.length}件 (重複排除後)`);

      // マッチング再判定 (タイトルに品種名が含まれるか)
      const matched = items.filter(item =>
        isMatch(item.title, order.productName, variations)
      );
      console.log(`  マッチ: ${matched.length}件`);

      // 新着のみ抽出
      const newItems = matched.filter(item => !seenIds.has(item.id));
      console.log(`  新着: ${newItems.length}件`);

      // Discord通知
      for (const item of newItems) {
        await sendDiscordNotification(item, order);
        newSeenIds.add(item.id);
        totalNotify++;
        await sleep(1100); // Discord レート制限対策
      }
    } catch (err) {
      console.error(`[エラー] "${order.productName}":`, err.message);
    }

    // 商品間スリープ
    await sleep(2000);
  }

  // 4. 通知済みIDを保存
  await saveSeenIds(Array.from(newSeenIds));

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n[完了] 通知: ${totalNotify}件 / 実行時間: ${elapsed}秒`);
}

/**
 * product_name で重複排除 (発送期限が近い方を優先)
 */
function dedupeByProductName(orders) {
  const map = new Map();
  for (const order of orders) {
    const key = order.productName;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, order);
      continue;
    }
    // より発送期限が近い方を優先
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
