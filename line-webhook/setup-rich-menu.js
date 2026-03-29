#!/usr/bin/env node
/**
 * 一次性腳本：為老闆建立 LINE Rich Menu「待結案」按鈕
 *
 * 使用方式：
 *   npm install canvas        （第一次需要安裝）
 *   node setup-rich-menu.js <LINE_CHANNEL_ACCESS_TOKEN> <OWNER_USER_ID>
 *
 * 執行後老闆的 LINE 聊天室底部會出現「📋 待結案」，
 * 點展開後會看到一個漂亮的按鈕，點按鈕發送「結案」觸發 bot。
 */

const TOKEN = process.argv[2];
const OWNER_ID = process.argv[3];

if (!TOKEN || !OWNER_ID) {
  console.error('用法: node setup-rich-menu.js <LINE_CHANNEL_ACCESS_TOKEN> <OWNER_USER_ID>');
  process.exit(1);
}

const API = 'https://api.line.me/v2/bot';
const headers = { Authorization: `Bearer ${TOKEN}` };

// ══════════════════════════════════════
//  用 canvas 產生按鈕圖片
// ══════════════════════════════════════

function createButtonImage() {
  const { createCanvas } = require('canvas');
  const W = 2500, H = 422;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // 背景：深色
  ctx.fillStyle = '#1A1A2E';
  ctx.fillRect(0, 0, W, H);

  // 圓角按鈕
  const btnW = 1000, btnH = 200;
  const btnX = (W - btnW) / 2;
  const btnY = (H - btnH) / 2;
  const radius = 40;

  ctx.beginPath();
  ctx.moveTo(btnX + radius, btnY);
  ctx.lineTo(btnX + btnW - radius, btnY);
  ctx.arcTo(btnX + btnW, btnY, btnX + btnW, btnY + radius, radius);
  ctx.lineTo(btnX + btnW, btnY + btnH - radius);
  ctx.arcTo(btnX + btnW, btnY + btnH, btnX + btnW - radius, btnY + btnH, radius);
  ctx.lineTo(btnX + radius, btnY + btnH);
  ctx.arcTo(btnX, btnY + btnH, btnX, btnY + btnH - radius, radius);
  ctx.lineTo(btnX, btnY + radius);
  ctx.arcTo(btnX, btnY, btnX + radius, btnY, radius);
  ctx.closePath();

  // 按鈕漸層
  const grad = ctx.createLinearGradient(btnX, btnY, btnX + btnW, btnY + btnH);
  grad.addColorStop(0, '#4A90D9');
  grad.addColorStop(1, '#357ABD');
  ctx.fillStyle = grad;
  ctx.fill();

  // 按鈕文字
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 72px "Noto Sans CJK TC", "Noto Sans TC", "Microsoft JhengHei", "PingFang TC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('查看待結案客戶', W / 2, H / 2);

  return canvas.toBuffer('image/png');
}

// ══════════════════════════════════════
//  主流程
// ══════════════════════════════════════

async function main() {
  // 先刪除所有舊的 Rich Menu
  console.log('0/4 清除舊的 Rich Menu...');
  try {
    const listRes = await fetch(`${API}/richmenu/list`, { headers });
    if (listRes.ok) {
      const { richmenus } = await listRes.json();
      for (const rm of richmenus) {
        console.log(`   刪除 ${rm.richMenuId}...`);
        await fetch(`${API}/richmenu/${rm.richMenuId}`, { method: 'DELETE', headers });
      }
      console.log(`   已清除 ${richmenus.length} 個舊選單`);
    }
  } catch (e) {
    console.log('   清除舊選單時出錯（可忽略）:', e.message);
  }

  console.log('1/4 建立 Rich Menu...');
  const createRes = await fetch(`${API}/richmenu`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      size: { width: 2500, height: 422 },
      selected: false,
      name: '老闆結案選單',
      chatBarText: '📋 待結案',
      areas: [{
        bounds: { x: 0, y: 0, width: 2500, height: 422 },
        action: { type: 'message', label: '查看待結案客戶', text: '結案' },
      }],
    }),
  });

  if (!createRes.ok) {
    console.error('建立失敗:', await createRes.text());
    process.exit(1);
  }

  const { richMenuId } = await createRes.json();
  console.log('   Rich Menu ID:', richMenuId);

  console.log('2/4 產生按鈕圖片並上傳...');
  const png = createButtonImage();
  console.log('   圖片大小:', png.length, 'bytes');

  // 用 https 模組上傳（避免 fetch 的 Buffer 相容問題）
  const uploadOk = await new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.request({
      hostname: 'api-data.line.me',
      path: `/v2/bot/richmenu/${richMenuId}/content`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'image/png',
        'Content-Length': png.length,
      },
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(true);
        } else {
          console.error('   上傳失敗:', res.statusCode, body);
          resolve(false);
        }
      });
    });
    req.on('error', reject);
    req.write(png);
    req.end();
  });

  if (!uploadOk) process.exit(1);
  console.log('   圖片上傳完成');

  console.log('3/4 綁定到老闆帳號...');
  const linkRes = await fetch(`${API}/user/${OWNER_ID}/richmenu/${richMenuId}`, {
    method: 'POST',
    headers,
  });

  if (!linkRes.ok) {
    console.error('綁定失敗:', await linkRes.text());
    process.exit(1);
  }
  console.log('   綁定成功');

  console.log('4/4 完成！');
  console.log('');
  console.log('✅ 老闆的 LINE 聊天室底部現在會出現「📋 待結案」');
  console.log('   點開後會看到藍色按鈕「查看待結案客戶」，點了就列出名單。');
  console.log('');
  console.log('📌 Rich Menu ID:', richMenuId);
}

main().catch(err => {
  console.error('執行錯誤:', err.message);
  process.exit(1);
});
