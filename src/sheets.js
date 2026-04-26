// src/sheets.js
// Google スプレッドシート連携
// - orders シート: 注文情報を読み込み (E列:product_name, L列:net_revenue, O列:status)
// - nae_cache シート: 揺らぎキャッシュ (1度生成したらここに保存して使い回す)
// - nae_seen シート: 通知済み商品ID (重複通知防止)

import { google } from 'googleapis';

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const SHEET_ORDERS = 'orders';
const SHEET_CACHE = 'nae_cache';
const SHEET_SEEN = 'nae_seen';

// orders シートの列定義 (1-indexed)
const COL_SHIP_DUE = 4;       // D
const COL_PRODUCT_NAME = 5;   // E
const COL_PRICE = 8;          // H
const COL_NET_REVENUE = 12;   // L
const COL_STATUS = 15;        // O

// 検索対象のステータス
const TARGET_STATUSES = ['NEW', 'BUY_NG'];

let _sheetsClient = null;

async function getSheetsClient() {
  if (_sheetsClient) return _sheetsClient;
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  _sheetsClient = google.sheets({ version: 'v4', auth: authClient });
  return _sheetsClient;
}

/**
 * 必要なシート (nae_cache, nae_seen) が存在しなければ作成
 */
export async function ensureSheets() {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existing = new Set(meta.data.sheets.map(s => s.properties.title));

  const requests = [];
  if (!existing.has(SHEET_CACHE)) {
    requests.push({ addSheet: { properties: { title: SHEET_CACHE } } });
  }
  if (!existing.has(SHEET_SEEN)) {
    requests.push({ addSheet: { properties: { title: SHEET_SEEN } } });
  }
  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests },
    });
    console.log(`シート作成: ${requests.map(r => r.addSheet.properties.title).join(', ')}`);
  }

  // ヘッダー行を整える
  if (!existing.has(SHEET_CACHE)) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_CACHE}!A1:B1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['product_name', 'variations(カンマ区切り)']] },
    });
  }
  if (!existing.has(SHEET_SEEN)) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_SEEN}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['item_id']] },
    });
  }
}

/**
 * orders シートから検索対象の注文を読み込む
 * status が NEW または BUY_NG の行のみ
 * @returns {Promise<Array<{productName, price, netRevenue, status, shipDueDate, rowIndex}>>}
 */
export async function loadTargetOrders() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_ORDERS}!A2:T1000`,
  });

  const rows = res.data.values || [];
  const orders = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const productName = (row[COL_PRODUCT_NAME - 1] || '').trim();
    const status = (row[COL_STATUS - 1] || '').trim();
    const netRevenueStr = String(row[COL_NET_REVENUE - 1] || '').replace(/[¥,]/g, '');
    const priceStr = String(row[COL_PRICE - 1] || '').replace(/[¥,]/g, '');
    const shipDueDate = (row[COL_SHIP_DUE - 1] || '').trim();

    const netRevenue = parseInt(netRevenueStr, 10);
    const price = parseInt(priceStr, 10);

    if (!productName) continue;
    if (!TARGET_STATUSES.includes(status)) continue;
    if (isNaN(netRevenue) || netRevenue <= 0) {
      console.warn(`  [警告] 行${i + 2}: net_revenue が無効 - "${productName}" スキップ`);
      continue;
    }

    orders.push({
      productName,
      price: isNaN(price) ? 0 : price,
      netRevenue,
      status,
      shipDueDate,
      rowIndex: i + 2, // スプレッドシート行番号 (1-indexed, ヘッダー込み)
    });
  }

  return orders;
}

/**
 * 揺らぎキャッシュを取得
 * @returns {Promise<Map<string, Array<string>>>} product_name -> variations
 */
export async function loadVariationsCache() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_CACHE}!A2:B5000`,
  });

  const rows = res.data.values || [];
  const cache = new Map();
  for (const row of rows) {
    const productName = (row[0] || '').trim();
    const variationsStr = (row[1] || '').trim();
    if (!productName) continue;
    const variations = variationsStr
      ? variationsStr.split(',').map(v => v.trim()).filter(v => v)
      : [];
    cache.set(productName, variations);
  }
  return cache;
}

/**
 * 揺らぎキャッシュに新規エントリを追加
 * 既存エントリは更新しない (一度生成したら使い回す)
 * @param {string} productName
 * @param {Array<string>} variations
 */
export async function appendVariationCache(productName, variations) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_CACHE}!A:B`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[productName, variations.join(', ')]],
    },
  });
}

/**
 * 通知済み商品ID一覧を取得
 * @returns {Promise<Set<string>>}
 */
export async function loadSeenIds() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_SEEN}!A2:A5000`,
  });
  const rows = res.data.values || [];
  return new Set(rows.map(r => r[0]).filter(Boolean));
}

/**
 * 通知済み商品IDを保存 (全置換、直近2000件のみ保持)
 * @param {Array<string>} ids
 */
export async function saveSeenIds(ids) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_SEEN}!A2:A`,
  });
  if (ids.length === 0) return;
  const trimmed = ids.slice(-2000);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_SEEN}!A2`,
    valueInputOption: 'RAW',
    requestBody: {
      values: trimmed.map(id => [id]),
    },
  });
}
