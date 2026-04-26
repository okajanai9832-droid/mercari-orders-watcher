// src/discord.js
// Discord Webhook 通知

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

/**
 * 仕入れ候補商品を Discord に通知
 * @param {Object} item - メルカリ商品 {id, title, price, imageUrl, url}
 * @param {Object} order - 元注文情報 {productName, price, netRevenue, status, shipDueDate}
 */
export async function sendDiscordNotification(item, order) {
  // 利益見込み計算
  const expectedProfit = order.netRevenue - item.price;
  const profitRate = order.netRevenue > 0
    ? Math.round((expectedProfit / order.netRevenue) * 100)
    : 0;

  // 緊急度判定 (発送期限まであと何日か)
  const urgency = calcUrgency(order.shipDueDate);

  // 色分け
  let color = 0x4CAF50; // 緑 (利益十分)
  if (expectedProfit < 1000) color = 0xFF9800;  // オレンジ (利益薄)
  if (expectedProfit < 0) color = 0xF44336;     // 赤 (赤字 = 通常はここまで来ない)
  if (urgency.isUrgent) color = 0xE91E63;        // ピンク (緊急)

  // タイトル
  const urgencyEmoji = urgency.isUrgent ? '🔥 ' : '🌱 ';
  const statusBadge = order.status === 'BUY_NG' ? '[再探索]' : '[新規]';

  const embed = {
    title: `${urgencyEmoji}${statusBadge} ${order.productName}`,
    url: item.url,
    description: [
      `📦 **発送期限**: ${order.shipDueDate} ${urgency.label}`,
      `💴 **販売価格**: ¥${order.price.toLocaleString()}`,
      `🎯 **仕入上限**: ¥${order.netRevenue.toLocaleString()} (純売上)`,
    ].join('\n'),
    color,
    fields: [
      {
        name: '🛒 メルカリ出品',
        value: `**${item.title.slice(0, 200)}**\n価格: **¥${item.price.toLocaleString()}**`,
        inline: false,
      },
      {
        name: '💰 利益見込み',
        value: expectedProfit >= 0
          ? `**+¥${expectedProfit.toLocaleString()}** (利益率 ${profitRate}%)`
          : `⚠️ **−¥${Math.abs(expectedProfit).toLocaleString()}** (赤字)`,
        inline: true,
      },
      {
        name: '🔗 アクション',
        value: `[メルカリで開く](${item.url})`,
        inline: true,
      },
    ],
    footer: {
      text: `mercari.com  •  ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`,
    },
  };

  // 画像
  if (item.imageUrl && item.imageUrl.startsWith('https://')) {
    embed.image = { url: item.imageUrl };
  }

  const payload = {
    username: '苗仕入れBot',
    avatar_url: 'https://cdn-icons-png.flaticon.com/512/628/628324.png',
    content: urgency.isUrgent ? '🔥 **緊急仕入れ候補** 🔥' : null,
    embeds: [embed],
  };

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }
    console.log(`  [Discord通知] ${order.productName} → ¥${item.price} (利益+¥${expectedProfit})`);
  } catch (err) {
    console.error('  [Discord通知エラー]', err.message);
  }
}

/**
 * 発送期限までの緊急度を判定
 */
function calcUrgency(shipDueDate) {
  if (!shipDueDate) {
    return { isUrgent: false, label: '' };
  }
  const due = new Date(shipDueDate);
  if (isNaN(due.getTime())) {
    return { isUrgent: false, label: '' };
  }

  const now = new Date();
  // 日付差 (日数)
  const diffMs = due.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    return { isUrgent: true, label: '⚠️ 期限超過!' };
  }
  if (diffDays === 0) {
    return { isUrgent: true, label: '⚠️ 今日まで!' };
  }
  if (diffDays <= 2) {
    return { isUrgent: true, label: `⚠️ 残り${diffDays}日` };
  }
  if (diffDays <= 5) {
    return { isUrgent: false, label: `(残り${diffDays}日)` };
  }
  return { isUrgent: false, label: `(残り${diffDays}日)` };
}
