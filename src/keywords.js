// src/keywords.js
// 商品名から検索キーワードを抽出 + 表記揺らぎを生成
// 例: "クマガイソウの苗 抜き苗 3苗" → ["クマガイソウ 苗", "クマガイソウ 抜き苗", "クマガイソウ"]

// 苗界隈でよく使われるサフィックス(これらと組み合わせて検索する)
const COMMON_SUFFIXES = [
  '',          // 品種名のみ
  '苗',
  '抜き苗',
  '根付苗',
  '球根',
  '山野草',
];

// 商品名から取り除くべき要素 (数量・単位・修飾語)
const NOISE_PATTERNS = [
  /\d+苗/g,         // "3苗" "10苗"
  /\d+本/g,         // "20本" "50本"
  /\d+株/g,         // "1株"
  /\d+球/g,         // "1球"
  /\d+鉢/g,         // "1鉢"
  /\d+ポット/g,     // "3ポット"
  /\d+個/g,
  /\d+セット/g,
  /[(（].*?[)）]/g,  // 括弧内
  /【.*?】/g,        // 隅付き括弧内
  /\[.*?\]/g,
];

// 商品名から取り除くべき単語 (商品名の一部だが、検索クエリには不要)
const REMOVE_WORDS = [
  'の苗', 'の球根', 'の苗木',
  '抜き苗', '根付苗', '根付き苗', '根付', '根付き',
  '球根', '苗木', '苗',
  'ピンク', '白', '赤', '青', '黄', '紫', // 色は植物名と切り離して再結合
  '大', '中', '小', 'mini', 'ミニ',
];

// 漢字 ⇄ カタカナ 山野草・園芸植物の対応辞書
// ヒットした商品名で漢字 / カナ どちらでも対応できるように
const KANJI_KANA_MAP = {
  // 山野草
  'クマガイソウ': ['熊谷草'],
  'シラネアオイ': ['白根葵'],
  'カタクリ': ['片栗'],
  'ユキワリソウ': ['雪割草'],
  'ホトトギス': ['杜鵑草', '杜鵑'],
  'イカリソウ': ['碇草', '錨草'],
  'エンレイソウ': ['延齢草'],
  'ハクサンチドリ': ['白山千鳥'],
  'コマクサ': ['駒草'],
  'リンドウ': ['竜胆'],
  'スズラン': ['鈴蘭'],
  'シャクヤク': ['芍薬'],
  'ボタン': ['牡丹'],
  // 球根類
  'ヒヤシンス': ['Hyacinth'],
  'チューリップ': ['Tulip'],
  'スイセン': ['水仙', 'Narcissus'],
  // 食用・ハーブ
  'セリ': ['芹'],
  'ミツバ': ['三つ葉', '三葉'],
  'シソ': ['紫蘇'],
  'ミョウガ': ['茗荷'],
  // 園芸
  'アジサイ': ['紫陽花'],
  'ウメ': ['梅'],
  'サクラ': ['桜'],
  'モミジ': ['紅葉'],
  // 必要に応じて追加
};

/**
 * 商品名のメインとなる植物名(品種名)を抽出
 * @param {string} productName 例: "クマガイソウの苗 抜き苗 3苗"
 * @returns {string} 例: "クマガイソウ"
 */
export function extractMainName(productName) {
  let name = productName.trim();

  // ノイズパターンを除去
  for (const pattern of NOISE_PATTERNS) {
    name = name.replace(pattern, ' ');
  }

  // 不要ワードを除去 (長いものから順に除去)
  const sortedRemoveWords = [...REMOVE_WORDS].sort((a, b) => b.length - a.length);
  for (const word of sortedRemoveWords) {
    name = name.split(word).join(' ');
  }

  // 連続スペースを単一スペースに
  name = name.replace(/\s+/g, ' ').trim();

  // 残った最初のトークンが品種名 (一番長いトークンを採用)
  const tokens = name.split(/\s+/).filter(t => t.length > 0);
  if (tokens.length === 0) return productName.trim();

  // 一番長いトークンをメイン名とする (短いトークンはたいてい修飾語)
  const mainToken = tokens.reduce((a, b) => a.length >= b.length ? a : b);

  return mainToken;
}

/**
 * メイン名から検索クエリの配列を生成 (揺らぎ込み)
 * 商品名・揺らぎ × 共通サフィックス の組み合わせ
 * @param {string} productName
 * @param {Array<string>} cachedVariations - 過去に生成済みの揺らぎ (キャッシュから)
 * @returns {Array<string>} 検索クエリ配列
 */
export function buildSearchQueries(productName, cachedVariations = []) {
  const mainName = extractMainName(productName);

  // 名前のバリエーション
  const nameVariations = new Set([mainName]);

  // 漢字⇄カナ変換
  if (KANJI_KANA_MAP[mainName]) {
    for (const v of KANJI_KANA_MAP[mainName]) {
      nameVariations.add(v);
    }
  }
  // 逆方向 (漢字 → カナ)
  for (const [kana, kanjis] of Object.entries(KANJI_KANA_MAP)) {
    if (kanjis.includes(mainName)) {
      nameVariations.add(kana);
    }
  }

  // キャッシュ済みの揺らぎを追加
  for (const v of cachedVariations) {
    if (v && v.trim()) nameVariations.add(v.trim());
  }

  // 品種名 × サフィックス で検索クエリ生成
  const queries = new Set();
  for (const name of nameVariations) {
    for (const suffix of COMMON_SUFFIXES) {
      const q = suffix ? `${name} ${suffix}` : name;
      queries.add(q.trim());
    }
  }

  return Array.from(queries);
}

/**
 * 商品名から「揺らぎ候補」を生成 (ルールベース)
 * 新規追加された品種に対して1度だけ実行し、シートにキャッシュする
 * @param {string} productName
 * @returns {Array<string>} 揺らぎ候補
 */
export function generateVariations(productName) {
  const mainName = extractMainName(productName);
  const variations = new Set([mainName]);

  // 漢字⇄カナ
  if (KANJI_KANA_MAP[mainName]) {
    for (const v of KANJI_KANA_MAP[mainName]) {
      variations.add(v);
    }
  }
  for (const [kana, kanjis] of Object.entries(KANJI_KANA_MAP)) {
    if (kanjis.includes(mainName)) {
      variations.add(kana);
      for (const k of kanjis) variations.add(k);
    }
  }

  // ひらがな(カタカナ → ひらがな)も追加
  const hiragana = katakanaToHiragana(mainName);
  if (hiragana !== mainName) variations.add(hiragana);

  // メイン名を除外して返す (キャッシュには「追加の揺らぎ」だけ保存)
  variations.delete(mainName);
  return Array.from(variations);
}

/**
 * 商品タイトルが指定された品種に該当するかチェック (取得後の絞り込み用)
 * @param {string} itemTitle - メルカリ商品タイトル
 * @param {string} productName - スプレッドシートの product_name
 * @param {Array<string>} cachedVariations
 * @returns {boolean}
 */
export function isMatch(itemTitle, productName, cachedVariations = []) {
  const mainName = extractMainName(productName);
  const normalizedTitle = normalize(itemTitle);
  const checkNames = new Set([mainName, ...cachedVariations]);

  // 漢字⇄カナの両方をチェック対象に
  if (KANJI_KANA_MAP[mainName]) {
    for (const v of KANJI_KANA_MAP[mainName]) checkNames.add(v);
  }
  for (const [kana, kanjis] of Object.entries(KANJI_KANA_MAP)) {
    if (kanjis.includes(mainName)) {
      checkNames.add(kana);
      for (const k of kanjis) checkNames.add(k);
    }
  }

  // ひらがな
  checkNames.add(katakanaToHiragana(mainName));

  for (const name of checkNames) {
    if (!name || !name.trim()) continue;
    if (normalizedTitle.includes(normalize(name))) {
      return true;
    }
  }
  return false;
}

/**
 * 文字列正規化 (マッチング用)
 * - 全角英数字 → 半角
 * - 小文字化
 * - 記号・スペース除去
 */
function normalize(str) {
  if (!str) return '';
  return str
    // 全角英数 → 半角
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c =>
      String.fromCharCode(c.charCodeAt(0) - 0xFEE0)
    )
    // 全角カタカナ→半角→そのまま (一旦スキップ)
    .toLowerCase()
    .replace(/[\s\-_・,。、.]/g, '');
}

/**
 * カタカナをひらがなに変換
 */
function katakanaToHiragana(str) {
  return str.replace(/[\u30A1-\u30F6]/g, c =>
    String.fromCharCode(c.charCodeAt(0) - 0x60)
  );
}
