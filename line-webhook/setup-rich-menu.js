#!/usr/bin/env node
/**
 * 一次性腳本：為老闆建立 LINE Rich Menu（三按鈕：開案 + 結案 + 預約時間）
 *
 * 使用方式：
 *   npm install canvas        （第一次需要安裝）
 *   node setup-rich-menu.js <LINE_CHANNEL_ACCESS_TOKEN> <OWNER_USER_ID>
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
//  用 canvas 產生三按鈕圖片
// ══════════════════════════════════════

function drawRoundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function createButtonImage() {
  const { createCanvas } = require('canvas');
  const W = 2500, H = 506;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // 背景
  ctx.fillStyle = '#1A1A2E';
  ctx.fillRect(0, 0, W, H);

  const btnW = 680, btnH = 240, radius = 44;
  const btnY = (H - btnH) / 2;
  const gap = 80;
  const totalW = btnW * 3 + gap * 2;
  const startX = (W - totalW) / 2;

  ctx.font = 'bold 68px "Noto Sans CJK TC", "Noto Sans TC", "Microsoft JhengHei", "PingFang TC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // 左按鈕：開案（橘色）
  drawRoundedRect(ctx, startX, btnY, btnW, btnH, radius);
  const grad1 = ctx.createLinearGradient(startX, btnY, startX + btnW, btnY + btnH);
  grad1.addColorStop(0, '#E67E22');
  grad1.addColorStop(1, '#D35400');
  ctx.fillStyle = grad1;
  ctx.fill();

  ctx.fillStyle = '#FFFFFF';
  ctx.fillText('開案', startX + btnW / 2, btnY + btnH / 2);

  // 中按鈕：結案（藍色）
  const btn2X = startX + btnW + gap;
  drawRoundedRect(ctx, btn2X, btnY, btnW, btnH, radius);
  const grad2 = ctx.createLinearGradient(btn2X, btnY, btn2X + btnW, btnY + btnH);
  grad2.addColorStop(0, '#4A90D9');
  grad2.addColorStop(1, '#357ABD');
  ctx.fillStyle = grad2;
  ctx.fill();

  ctx.fillStyle = '#FFFFFF';
  ctx.fillText('結案', btn2X + btnW / 2, btnY + btnH / 2);

  // 右按鈕：預約時間（綠色）
  const btn3X = btn2X + btnW + gap;
  drawRoundedRect(ctx, btn3X, btnY, btnW, btnH, radius);
  const grad3 = ctx.createLinearGradient(btn3X, btnY, btn3X + btnW, btnY + btnH);
  grad3.addColorStop(0, '#27AE60');
  grad3.addColorStop(1, '#1E8449');
  ctx.fillStyle = grad3;
  ctx.fill();

  ctx.fillStyle = '#FFFFFF';
  ctx.fillText('預約時間', btn3X + btnW / 2, btnY + btnH / 2);

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
      size: { width: 2500, height: 506 },
      selected: false,
      name: '老闆工具列',
      chatBarText: '📋 管理工具',
      areas: [
        {
          bounds: { x: 0, y: 0, width: 833, height: 506 },
          action: { type: 'message', label: '開案', text: '開案' },
        },
        {
          bounds: { x: 833, y: 0, width: 834, height: 506 },
          action: { type: 'message', label: '結案', text: '結案' },
        },
        {
          bounds: { x: 1667, y: 0, width: 833, height: 506 },
          action: { type: 'message', label: '預約時間', text: '預約時間' },
        },
      ],
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
  console.log('✅ 老闆的 LINE 聊天室底部現在有三個按鈕：');
  console.log('   🟠 開案 — 列出待開案客戶，手動設為進行中');
  console.log('   🔵 結案 — 列出可結案的客戶');
  console.log('   🟢 預約時間 — 為客戶預約時間');
  console.log('');
  console.log('📌 Rich Menu ID:', richMenuId);
}

main().catch(err => {
  console.error('執行錯誤:', err.message);
  process.exit(1);
});
