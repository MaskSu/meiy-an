/**
 * LINE Webhook Handler - Cloudflare Worker
 * 「I LUV尹澤鎂研」車內清潔／修復 LINE 機器人
 *
 * 環境變數（在 Cloudflare Dashboard 設定，不要寫在程式碼裡）：
 *   LINE_CHANNEL_SECRET      - LINE Channel Secret（用來驗證請求合法性）
 *   LINE_CHANNEL_ACCESS_TOKEN - LINE Channel Access Token（用來發訊息）
 *   GAS_URL                  - Google Apps Script URL（用來存照片 + 記錄）
 *   OWNER_USER_ID            - 老闆的 LINE userId（用來接收通知）
 *
 * KV Namespace（在 wrangler.toml 綁定）：
 *   CHAT_STATE               - 記錄客戶對話狀態（idle / active）
 */

// 用來防止同一用戶短時間內收到多次照片回覆
const recentImageReplies = new Map();
const IMAGE_REPLY_COOLDOWN = 10000; // 10 秒內不重複回覆


// ══════════════════════════════════════════════════
//  迎賓語與第一道選項
// ══════════════════════════════════════════════════

function getWelcomeText(name) {
  return `${name} 您好！😊\n\n只需要 3 步驟就能完成評估：\n① 選擇車況問題\n② 選擇車款\n③ 拍照上傳\n\n先選一下目前的狀況吧 👇`;
}

const WELCOME_OPTIONS = [
  { label: '煙味或異味',   text: '車內有煙味或異味' },
  { label: '剛買二手車',   text: '剛買二手車，想整理' },
  { label: '污垢嚴重',     text: '車內污垢嚴重' },
  { label: '許久未清潔',   text: '內裝許久未清潔' },
  { label: '打翻飲料',     text: '打翻冷熱飲' },
  { label: '地毯積水',     text: '地毯積水' },
  { label: '皮革受損',     text: '座椅皮革受損' },
  { label: '頂篷塌陷',     text: '頂篷絨布塌陷' },
  { label: '安卓車機',     text: '安裝安卓車機' },
  { label: '不方便拍照',   text: '不方便拍照' },
  { label: '直接到店評估', text: '直接到店評估' },
];


// ══════════════════════════════════════════════════
//  拍照提示（所有內裝服務共用）
// ══════════════════════════════════════════════════

const PHOTO_TIPS = '📸 拍照小技巧（可參考上方圖片）：\n① 車門打開，站車外往內拍\n② 拍近一點，對準問題部位\n③ 光線充足，不用開廣角\n\n照片越清楚，報價越準確哦！';


// ══════════════════════════════════════════════════
//  服務設定（觸發文字 → 短代碼 → 完整設定）
// ══════════════════════════════════════════════════

const TRIGGER_TO_KEY = {
  '車內有煙味或異味': 'smoke',
  '剛買二手車，想整理': 'used',
  '車內污垢嚴重': 'dirty',
  '內裝許久未清潔': 'dusty',
  '打翻冷熱飲': 'spill',
  '地毯積水': 'flood',
  '座椅皮革受損': 'leather',
  '頂篷絨布塌陷': 'ceiling',
};

const SERVICE_CONFIG = {
  smoke: {
    name: '煙味或異味',
    brandAsk: '好的！菸味跟異味要看滲入的程度來決定處理方式 💪\n\n先幫我確認一下車款，方便我評估哦～\n請問您的車子是什麼廠牌？👇',
    followUpText: '再幫我確認一下，主要是哪種狀況呢？👇',
    followUp: [
      { label: '菸味很重',   text: '追問｜smoke｜菸味很重' },
      { label: '有霉味',     text: '追問｜smoke｜有霉味' },
      { label: '有泛黃',     text: '追問｜smoke｜有泛黃' },
      { label: '皮革黏膩',   text: '追問｜smoke｜皮革黏膩' },
    ],
    photos: [
      'https://www.yinzemy.com/sample-pic/normal.jpg',
      'https://www.yinzemy.com/sample-pic/fouces.jpg',
    ],
  },
  used: {
    name: '二手車整理',
    brandAsk: '恭喜入手新車！🎉 二手車內裝通常有前車主的使用痕跡，清一次整體質感會差很多～\n\n先幫我確認一下車款，方便我評估哦～\n請問您的車子是什麼廠牌？👇',
    followUpText: '再幫我確認一下，車內有以下哪些狀況呢？👇',
    followUp: [
      { label: '有菸味',     text: '追問｜used｜有菸味' },
      { label: '有霉味',     text: '追問｜used｜有霉味' },
      { label: '有泛黃',     text: '追問｜used｜有泛黃' },
      { label: '皮革有油垢', text: '追問｜used｜皮革有油垢' },
    ],
    photos: [
      'https://www.yinzemy.com/sample-pic/normal.jpg',
      'https://www.yinzemy.com/sample-pic/fouces.jpg',
    ],
  },
  dirty: {
    name: '污垢嚴重',
    brandAsk: '了解！嚴重髒污通常建議做拆洗，把座椅跟地毯整個拆下來徹底清潔 💪\n\n先幫我確認一下車款，方便我評估哦～\n請問您的車子是什麼廠牌？👇',
    followUpText: '再幫我確認一下，車內有異味嗎？👇',
    followUp: [
      { label: '有異味',   text: '追問｜dirty｜有異味' },
      { label: '沒有異味', text: '追問｜dirty｜沒有異味' },
      { label: '不確定',   text: '追問｜dirty｜不確定' },
    ],
    photos: [
      'https://www.yinzemy.com/sample-pic/normal.jpg',
      'https://www.yinzemy.com/sample-pic/fouces.jpg',
    ],
  },
  dusty: {
    name: '許久未清潔',
    brandAsk: '了解！久沒清潔的車子灰塵跟汙垢容易卡進縫隙，定期處理能延長內裝壽命哦～\n\n先幫我確認一下車款，方便我評估哦～\n請問您的車子是什麼廠牌？👇',
    followUpText: '再幫我確認一下，車內有異味嗎？👇',
    followUp: [
      { label: '有異味',   text: '追問｜dusty｜有異味' },
      { label: '沒有異味', text: '追問｜dusty｜沒有異味' },
      { label: '不確定',   text: '追問｜dusty｜不確定' },
    ],
    photos: [
      'https://www.yinzemy.com/sample-pic/normal.jpg',
      'https://www.yinzemy.com/sample-pic/fouces.jpg',
    ],
  },
  spill: {
    name: '打翻飲料',
    brandAsk: '了解！飲料打翻要看滲入的範圍跟材質，處理方式會不太一樣～\n\n先幫我確認一下車款，方便我評估哦～\n請問您的車子是什麼廠牌？👇',
    followUpText: '再幫我確認一下飲料的狀況，方便我評估 👇',
    followUp: [
      { label: '咖啡/茶',     text: '追問｜spill｜咖啡或茶' },
      { label: '含糖或奶類',   text: '追問｜spill｜含糖或奶類' },
      { label: '剛打翻',       text: '追問｜spill｜剛打翻' },
      { label: '打翻超過一天', text: '追問｜spill｜超過一天' },
    ],
    photos: [
      'https://www.yinzemy.com/sample-pic/normal.jpg',
      'https://www.yinzemy.com/sample-pic/fouces.jpg',
      'https://www.yinzemy.com/sample-pic/fouces-wet.jpg',
    ],
  },
  flood: {
    name: '地毯積水',
    brandAsk: '了解！地毯積水沒處理的話容易發霉產生異味，建議盡快處理比較好哦～\n\n先幫我確認一下車款，方便我評估哦～\n請問您的車子是什麼廠牌？👇',
    followUpText: '再幫我確認一下積水的狀況 👇',
    followUp: [
      { label: '下雨漏水',   text: '追問｜flood｜下雨漏水' },
      { label: '冷氣排水',   text: '追問｜flood｜冷氣排水' },
      { label: '洗車進水',   text: '追問｜flood｜洗車進水' },
      { label: '不確定原因', text: '追問｜flood｜不確定原因' },
    ],
    photos: [
      'https://www.yinzemy.com/sample-pic/normal.jpg',
      'https://www.yinzemy.com/sample-pic/fouces.jpg',
      'https://www.yinzemy.com/sample-pic/fouces-wet.jpg',
    ],
  },
  leather: {
    name: '皮革受損',
    brandAsk: '了解！皮革受損可以做局部修復，不一定要整個換，省錢又美觀哦 👍\n\n先幫我確認一下車款，方便我評估哦～\n請問您的車子是什麼廠牌？👇',
    followUpText: null,
    followUp: null,
    photos: [
      'https://www.yinzemy.com/sample-pic/normal.jpg',
      'https://www.yinzemy.com/sample-pic/fouces.jpg',
    ],
  },
  ceiling: {
    name: '頂篷塌陷',
    brandAsk: '了解！頂篷塌陷是蠻多老車會遇到的問題，可以做翻新處理的～\n\n先幫我確認一下車款，方便我評估哦～\n請問您的車子是什麼廠牌？👇',
    followUpText: '再幫我確認一下，您的車子有天窗嗎？👇',
    followUp: [
      { label: '有天窗',   text: '追問｜ceiling｜有天窗' },
      { label: '沒有天窗', text: '追問｜ceiling｜沒有天窗' },
    ],
    photos: [
      'https://www.yinzemy.com/sample-pic/normal.jpg',
      'https://www.yinzemy.com/sample-pic/fouces.jpg',
    ],
  },
};


// ══════════════════════════════════════════════════
//  急迫性篩選選項（照片上傳後詢問）
// ══════════════════════════════════════════════════

const URGENCY_OPTIONS = [
  { label: '急！盡快處理', text: '時程｜緊急' },
  { label: '不急，排隊就好', text: '時程｜排隊' },
  { label: '先了解費用',   text: '時程｜了解費用' },
];

// LINE 聯繫確認選項
const CONTACT_OPTIONS = [
  { label: '好，沒問題',   text: '聯繫｜好' },
  { label: '先用文字就好', text: '聯繫｜文字' },
];


// ══════════════════════════════════════════════════
//  安卓車機 - 廠牌與車型資料（台灣市場，電動車除外）
// ══════════════════════════════════════════════════

const CAR_BRANDS = {
  'Toyota':        ['Yaris Cross', 'Vios', 'Corolla Altis', 'Corolla Cross', 'Corolla Sport', 'Camry', 'RAV4', 'C-HR', 'Sienta', 'Town Ace', 'Hilux', 'Alphard'],
  'Honda':         ['Fit', 'City', 'Civic', 'CR-V', 'HR-V', 'Odyssey'],
  'Mazda':         ['Mazda2', 'Mazda3', 'CX-3', 'CX-30', 'CX-5', 'CX-60', 'CX-90', 'MX-5'],
  'Nissan':        ['Sentra', 'Altima', 'Kicks', 'X-Trail', 'Juke'],
  'Mitsubishi':    ['Colt Plus', 'Outlander', 'Eclipse Cross', 'Delica', 'Veryca'],
  'Ford':          ['Focus', 'Kuga', 'Tourneo Connect'],
  'Volkswagen':    ['Polo', 'Golf', 'Tiguan', 'T-Cross', 'T-Roc', 'Touran', 'Caddy'],
  'BMW':           ['1系列', '2系列', '3系列', '4系列', '5系列', '7系列', 'X1', 'X3', 'X5'],
  'Mercedes-Benz': ['A-Class', 'C-Class', 'E-Class', 'S-Class', 'GLA', 'GLB', 'GLC', 'GLE'],
  'Hyundai':       ['Venue', 'Tucson', 'Santa Fe', 'Kona'],
  'Subaru':        ['Impreza', 'Crosstrek', 'Forester', 'Outback', 'WRX'],
  'Lexus':         ['UX', 'NX', 'RX', 'ES', 'IS', 'LS'],
};

const OTHER_CAR_BRANDS = {
  'Kia':     ['Picanto', 'Stonic', 'Sportage', 'Carnival'],
  'Suzuki':  ['Swift', 'Vitara', 'Jimny', 'S-Cross'],
  'Skoda':   ['Fabia', 'Scala', 'Octavia', 'Karoq', 'Kodiaq', 'Superb'],
  'Volvo':   ['XC40', 'XC60', 'XC90', 'S60', 'V60'],
  'Porsche': ['911', '718', 'Cayenne', 'Macan', 'Panamera'],
  'Peugeot': ['208', '2008', '308', '3008', '408', '5008'],
};

// 合併所有品牌用於查詢
const ALL_BRANDS = { ...CAR_BRANDS, ...OTHER_CAR_BRANDS };


// ══════════════════════════════════════════════════
//  入口觸發詞 & 固定關鍵字回覆
// ══════════════════════════════════════════════════

// 重選觸發詞（不管 idle/active 都可以觸發，客戶明確要重選）
const RESET_TRIGGERS = ['菜單', '選單', '重新選擇', '重選'];

// 招呼觸發詞（只在 idle 狀態才觸發選單）
const GREETING_TRIGGERS = ['你好', '哈囉', '嗨', 'hi', 'hello', '安安', '開始', '服務'];

const KEYWORD_REPLIES = {
  '地址': '📍 我們在高雄市鳥松區中正路101號哦！\n（近文山派出所、長庚醫院）\n\n歡迎過來看看～\nhttps://maps.google.com/?q=高雄市鳥松區中正路101號',
  '在哪': '📍 我們在高雄市鳥松區中正路101號哦！\n（近文山派出所、長庚醫院）\n\n歡迎過來看看～\nhttps://maps.google.com/?q=高雄市鳥松區中正路101號',
  '電話': '📞 0966-909-981\n歡迎隨時來電，我們很樂意為您服務！',
  '營業時間': '我們的營業時間是週一至週日 09:00–18:00 哦！\n📍 高雄市鳥松區中正路101號\n\n歡迎隨時聯繫我們 😊',
};


// ══════════════════════════════════════════════════
//  工具函式
// ══════════════════════════════════════════════════

// 組裝帶有快速選項的 LINE 文字訊息
function buildTextMessage(text, options) {
  const msg = { type: 'text', text };
  if (options && options.length > 0) {
    msg.quickReply = {
      items: options.map(opt => ({
        type: 'action',
        action: { type: 'message', label: opt.label, text: opt.text }
      }))
    };
  }
  return msg;
}

// 組裝 LINE 圖片訊息
function buildImageMessage(url) {
  return {
    type: 'image',
    originalContentUrl: url,
    previewImageUrl: url,
  };
}

// 組裝日誌用的完整回覆內容（含選項文字）
function buildLogContent(text, options) {
  if (!options || options.length === 0) return text;
  const optionLines = options.map((opt, i) => `${i + 1}. ${opt.label}`).join('\n');
  return `${text}\n\n【選項】\n${optionLines}`;
}

// 產生內裝服務用的廠牌選單（Quick Reply 選項）
function buildBrandOptions(prefix) {
  const options = Object.keys(CAR_BRANDS).map(b => ({
    label: b, text: `${prefix}${b}`
  }));
  options.push({ label: '其他廠牌', text: `${prefix}其他品牌` });
  return options; // 12 + 1 = 13（Quick Reply 上限）
}

// 組裝迎賓選單 Flex Message（按鈕卡片，4 排網格）
function buildWelcomeFlexMessage(introText) {
  const btn = (label, text) => ({
    type: 'button',
    style: 'secondary',
    height: 'sm',
    action: { type: 'message', label, text },
    flex: 1,
  });

  return {
    type: 'flex',
    altText: '請問您的車子目前遇到什麼狀況呢？👇',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: 'lg',
        contents: [
          {
            type: 'text',
            text: introText,
            wrap: true,
            size: 'sm',
            color: '#555555',
          },
          { type: 'separator', margin: 'lg' },
          {
            type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'lg',
            contents: [
              btn('煙味或異味', '車內有煙味或異味'),
              btn('二手車整理', '剛買二手車，想整理'),
            ],
          },
          {
            type: 'box', layout: 'horizontal', spacing: 'sm',
            contents: [
              btn('污垢嚴重', '車內污垢嚴重'),
              btn('許久未清潔', '內裝許久未清潔'),
            ],
          },
          {
            type: 'box', layout: 'horizontal', spacing: 'sm',
            contents: [
              btn('打翻飲料', '打翻冷熱飲'),
              btn('地毯積水', '地毯積水'),
            ],
          },
          {
            type: 'box', layout: 'horizontal', spacing: 'sm',
            contents: [
              btn('皮革受損', '座椅皮革受損'),
              btn('頂篷塌陷', '頂篷絨布塌陷'),
            ],
          },
          { type: 'separator', margin: 'lg' },
          {
            type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'lg',
            contents: [
              btn('RD 安卓車機·記錄器', '安裝安卓車機'),
            ],
          },
          { type: 'separator', margin: 'lg' },
          {
            type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'lg',
            contents: [
              btn('不便拍照', '不方便拍照'),
              btn('到店評估', '直接到店評估'),
            ],
          },
        ],
      },
    },
  };
}


// ══════════════════════════════════════════════════
//  主程式
// ══════════════════════════════════════════════════

export default {
  async fetch(request, env, ctx) {

    // GET /ics — 產生 .ics 日曆檔（萬用格式，支援 Apple / Android / Google）
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/ics') {
      return handleIcsPage(url.searchParams);
    }
    if (request.method === 'GET' && url.pathname === '/ics-raw') {
      return handleIcsRaw(url.searchParams);
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const body = await request.text();

    // 安全驗證
    const signature = request.headers.get('x-line-signature');
    if (!signature || !await verifySignature(body, signature, env.LINE_CHANNEL_SECRET)) {
      return new Response('Unauthorized', { status: 401 });
    }

    const { events } = JSON.parse(body);

    // 分組處理
    const followEvents = [];
    const textEvents = [];
    const postbackEvents = [];
    const imageGroups = {};

    for (const event of events) {
      // follow 事件：用戶加好友或解除封鎖
      if (event.type === 'follow') {
        followEvents.push(event);
        continue;
      }
      // postback 事件：日期時間選擇器回傳
      if (event.type === 'postback') {
        postbackEvents.push(event);
        continue;
      }
      if (event.type !== 'message') continue;
      if (event.message.type === 'text') {
        textEvents.push(event);
      } else if (event.message.type === 'image') {
        const uid = event.source.userId;
        if (!imageGroups[uid]) imageGroups[uid] = [];
        imageGroups[uid].push(event);
      }
    }

    const workerBaseUrl = new URL(request.url).origin;
    const followPromises = followEvents.map(event => handleFollow(event, env));
    const textPromises = textEvents.map(event => handleText(event, env, workerBaseUrl));
    const postbackPromises = postbackEvents.map(event => handlePostback(event, env, workerBaseUrl));
    const imagePromises = Object.values(imageGroups).map(
      userEvents => handleImageBatch(userEvents, env)
    );

    const allWork = Promise.all([...followPromises, ...textPromises, ...postbackPromises, ...imagePromises]);
    ctx.waitUntil(allWork);
    await allWork;

    return new Response('OK', { status: 200 });
  }
};


// ══════════════════════════════════════════════════
//  KV 狀態管理（idle = 顯示選單 / active = 對話中）
// ══════════════════════════════════════════════════

async function getUserState(env, userId) {
  if (!env.CHAT_STATE) return 'idle';
  const state = await env.CHAT_STATE.get(userId);
  return state || 'idle';
}

async function setUserState(env, userId, state) {
  if (!env.CHAT_STATE) return;
  // active 狀態 10 天後自動過期回 idle，避免卡住（老闆通常 7 天內結案）
  await env.CHAT_STATE.put(userId, state, { expirationTtl: 864000 });
}

// ── 進行中案件清單（供老闆結案用）──

async function getActiveCases(env) {
  if (!env.CHAT_STATE) return {};
  const raw = await env.CHAT_STATE.get('active_cases');
  return raw ? JSON.parse(raw) : {};
}

async function addActiveCase(env, userId, customerName) {
  if (!env.CHAT_STATE) return;
  const cases = await getActiveCases(env);
  cases[userId] = { name: customerName, ts: Date.now() };
  // 清理超過 10 天的舊案件
  const TEN_DAYS = 864000000;
  for (const [uid, info] of Object.entries(cases)) {
    if (Date.now() - info.ts > TEN_DAYS) delete cases[uid];
  }
  await env.CHAT_STATE.put('active_cases', JSON.stringify(cases));
}

async function removeActiveCase(env, userId) {
  if (!env.CHAT_STATE) return;
  const cases = await getActiveCases(env);
  delete cases[userId];
  await env.CHAT_STATE.put('active_cases', JSON.stringify(cases));
}


// ══════════════════════════════════════════════════
//  處理 Follow 事件（用戶加好友 → 發送歡迎選單）
// ══════════════════════════════════════════════════

async function handleFollow(event, env) {
  const userId = event.source.userId;
  await setUserState(env, userId, 'idle');

  const name = await getUserDisplayName(userId, env.LINE_CHANNEL_ACCESS_TOKEN);
  const welcomeMsg = buildWelcomeFlexMessage(getWelcomeText(name));
  await replyMessage(event.replyToken, [welcomeMsg], env.LINE_CHANNEL_ACCESS_TOKEN);
}


// ══════════════════════════════════════════════════
//  .ics 日曆（萬用格式：Apple / Android / Google）
// ══════════════════════════════════════════════════

// 共用：產生 .ics 內容
function buildIcsContent(title, start, end, location, description) {
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ILUV//LineBot//TW',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `DTSTART;TZID=Asia/Taipei:${start}`,
    `DTEND;TZID=Asia/Taipei:${end}`,
    `SUMMARY:${title}`,
    `LOCATION:${location}`,
    `DESCRIPTION:${description.replace(/\n/g, '\\n')}`,
    `DTSTAMP:${now}`,
    `UID:${start}-${Date.now()}@iluv-linebot`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

// /ics-raw — 直接回傳 .ics 檔案（手機會用日曆 app 開啟）
function handleIcsRaw(params) {
  const title = params.get('t') || '預約';
  const start = params.get('s') || '';
  const end = params.get('e') || '';
  const location = params.get('l') || '';
  const description = params.get('d') || '';

  if (!start || !end) {
    return new Response('Missing start/end', { status: 400 });
  }

  const ics = buildIcsContent(title, start, end, location, description);

  return new Response(ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="appointment.ics"',
    },
  });
}

// /ics — HTML 引導頁面（LINE 內建瀏覽器會開這個）
function handleIcsPage(params) {
  const title = params.get('t') || '預約';
  const start = params.get('s') || '';
  const end = params.get('e') || '';
  const location = params.get('l') || '';

  if (!start || !end) {
    return new Response('Missing start/end', { status: 400 });
  }

  const dYear = start.slice(0, 4);
  const dMonth = start.slice(4, 6);
  const dDay = start.slice(6, 8);
  const dHour = start.slice(9, 11);
  const dMin = start.slice(11, 13);
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const dateObj = new Date(parseInt(dYear), parseInt(dMonth) - 1, parseInt(dDay));
  const weekday = weekdays[dateObj.getDay()];
  const displayDate = `${dMonth}/${dDay}（${weekday}）${dHour}:${dMin}`;

  // 把 /ics 的參數原封不動轉給 /ics-raw
  const rawUrl = `/ics-raw?${params.toString()}`;

  const html = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>加入日曆</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 20px; }
    .card { background: white; border-radius: 16px; padding: 32px 24px; max-width: 360px; width: 100%; box-shadow: 0 2px 12px rgba(0,0,0,0.1); text-align: center; }
    .icon { font-size: 48px; margin-bottom: 16px; }
    .title { font-size: 20px; font-weight: bold; color: #333; margin-bottom: 8px; }
    .info { font-size: 15px; color: #666; margin-bottom: 4px; }
    .loc { font-size: 13px; color: #999; margin-top: 12px; }
    .btn { display: block; width: 100%; padding: 14px; margin-top: 24px; border: none; border-radius: 12px; font-size: 16px; font-weight: bold; color: white; background: linear-gradient(135deg, #1DB446, #17a03d); cursor: pointer; text-decoration: none; text-align: center; }
    .btn:active { opacity: 0.8; }
    .hint { font-size: 12px; color: #aaa; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">📅</div>
    <div class="title">${escapeHtml(title)}</div>
    <div class="info">${displayDate}</div>
    <div class="loc">📍 ${escapeHtml(location)}</div>
    <a class="btn" href="${escapeHtml(rawUrl)}">加入我的日曆</a>
    <div class="hint">支援 iPhone / Android / Google 日曆</div>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}


// ══════════════════════════════════════════════════
//  處理 Postback 事件（日期時間選擇器回傳）
// ══════════════════════════════════════════════════

async function handlePostback(event, env, workerBaseUrl) {
  const userId = event.source.userId;

  // 解析 postback data
  const params = new URLSearchParams(event.postback.data);
  const action = params.get('action');

  // ── 第一步：老闆選了「開始時間」→ 用 Quick Reply 選結束時間 ──
  if (action === 'schedule_start' && userId === env.OWNER_USER_ID) {
    const customerId = params.get('customerId');
    const datetime = event.postback.params?.datetime;

    if (!datetime || !customerId) {
      await replyMessage(event.replyToken, [{ type: 'text', text: '選擇時間失敗，請再試一次' }], env.LINE_CHANNEL_ACCESS_TOKEN);
      return;
    }

    // 暫存開始時間到 KV（10 分鐘過期）
    if (env.CHAT_STATE) {
      await env.CHAT_STATE.put(`schedule_${userId}`, JSON.stringify({ customerId, startDatetime: datetime }), { expirationTtl: 600 });
    }

    const [datePart, timePart] = datetime.split('T');
    const [year, month, day] = datePart.split('-');
    const [hour, minute] = timePart.split(':');
    const displayDate = `${month}/${day}（${getWeekday(year, month, day)}）`;
    const customerName = await getUserDisplayName(customerId, env.LINE_CHANNEL_ACCESS_TOKEN);

    // 預設結束 = 開始 +1 小時（Cloudflare Worker 是 UTC，需手動轉台灣 UTC+8）
    const startMs = new Date(`${datePart}T${timePart}:00+08:00`).getTime();
    const toTaiwanStr = (ms) => {
      const d = new Date(ms + 8 * 3600000); // 加 8 小時偏移，讓 toISOString 輸出台灣時間
      return d.toISOString().slice(0, 16);
    };
    const defEndStr = toTaiwanStr(startMs + 3600000);

    // 最遠可選 30 天後
    const maxEnd = toTaiwanStr(startMs + 30 * 86400000);

    // 用 Quick Reply 帶 datetimepicker（比 Flex 按鈕穩定）
    const msg = {
      type: 'text',
      text: `${customerName}\n開始：${displayDate} ${hour}:${minute}\n\n請點下方選擇結束時間 👇`,
      quickReply: {
        items: [
          {
            type: 'action',
            action: {
              type: 'datetimepicker',
              label: '選擇結束時間',
              data: 'action=schedule_end',
              mode: 'datetime',
              initial: defEndStr,
              min: datetime,
              max: maxEnd,
            },
          },
        ],
      },
    };

    await replyMessage(event.replyToken, [msg], env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }

  // ── 第二步：老闆選了「結束時間」→ 產生預約卡片 ──
  if (action === 'schedule_end' && userId === env.OWNER_USER_ID) {
    const endDatetime = event.postback.params?.datetime;

    // 從 KV 取出暫存的開始時間
    let scheduleData = null;
    if (env.CHAT_STATE) {
      const raw = await env.CHAT_STATE.get(`schedule_${userId}`);
      if (raw) scheduleData = JSON.parse(raw);
    }

    if (!scheduleData || !endDatetime) {
      await replyMessage(event.replyToken, [{ type: 'text', text: '操作逾時，請重新點「約時間」' }], env.LINE_CHANNEL_ACCESS_TOKEN);
      return;
    }

    const { customerId, startDatetime } = scheduleData;
    const customerName = await getUserDisplayName(customerId, env.LINE_CHANNEL_ACCESS_TOKEN);

    // 清除暫存
    if (env.CHAT_STATE) await env.CHAT_STATE.delete(`schedule_${userId}`);

    // 解析開始 & 結束時間
    const [sDatePart, sTimePart] = startDatetime.split('T');
    const [sY, sM, sD] = sDatePart.split('-');
    const [sH, sMin] = sTimePart.split(':');

    const [eDatePart, eTimePart] = endDatetime.split('T');
    const [eY, eM, eD] = eDatePart.split('-');
    const [eH, eMin] = eTimePart.split(':');

    const displayStartDate = `${sM}/${sD}（${getWeekday(sY, sM, sD)}）`;
    const displayStartTime = `${sH}:${sMin}`;
    const displayEndTime = `${eH}:${eMin}`;

    // 如果跨天，結束顯示日期
    const isSameDay = sDatePart === eDatePart;
    const displayEndFull = isSameDay
      ? displayEndTime
      : `${eM}/${eD}（${getWeekday(eY, eM, eD)}）${displayEndTime}`;
    const displayTimeRange = `${displayStartTime} - ${displayEndFull}`;

    const icsStart = `${sY}${sM}${sD}T${sH}${sMin}00`;
    const icsEnd = `${eY}${eM}${eD}T${eH}${eMin}00`;
    const location = '高雄市鳥松區中正路101號';

    // 客人的 .ics
    const customerIcsUrl = `${workerBaseUrl}/ics-raw?` + new URLSearchParams({
      t: `內裝清潔-${customerName}`,
      s: icsStart, e: icsEnd, l: location,
      d: `車內清潔/修復 預約評估\n📍 ${location}（近文山派出所、長庚醫院）`,
      openExternalBrowser: '1',
    }).toString();

    // 老闆的 .ics
    const ownerIcsUrl = `${workerBaseUrl}/ics-raw?` + new URLSearchParams({
      t: `內裝清潔-${customerName}`,
      s: icsStart, e: icsEnd, l: location,
      d: `客戶：${customerName}\n服務：車內清潔/修復評估\n📍 ${location}`,
      openExternalBrowser: '1',
    }).toString();

    // 客人的預約確認卡片
    const customerMsg = {
      type: 'flex',
      altText: `預約確認：${displayStartDate} ${displayTimeRange}`,
      contents: {
        type: 'bubble',
        body: {
          type: 'box', layout: 'vertical', spacing: 'md', paddingAll: 'lg',
          contents: [
            { type: 'text', text: '預約確認 ✅', weight: 'bold', size: 'xl', color: '#1DB446' },
            { type: 'separator', margin: 'lg' },
            {
              type: 'box', layout: 'vertical', spacing: 'sm', margin: 'lg',
              contents: [
                { type: 'box', layout: 'horizontal', contents: [
                  { type: 'text', text: '日期', size: 'sm', color: '#888888', flex: 2 },
                  { type: 'text', text: displayStartDate, size: 'sm', flex: 5, wrap: true },
                ]},
                { type: 'box', layout: 'horizontal', contents: [
                  { type: 'text', text: '時間', size: 'sm', color: '#888888', flex: 2 },
                  { type: 'text', text: displayTimeRange, size: 'sm', flex: 5, wrap: true },
                ]},
                { type: 'box', layout: 'horizontal', contents: [
                  { type: 'text', text: '地點', size: 'sm', color: '#888888', flex: 2 },
                  { type: 'text', text: location, size: 'sm', flex: 5, wrap: true },
                ]},
              ],
            },
            { type: 'separator', margin: 'lg' },
            { type: 'button', style: 'primary', height: 'sm', margin: 'lg',
              action: { type: 'uri', label: '加入我的日曆', uri: customerIcsUrl } },
            { type: 'text', text: '支援 iPhone / Android / Google 日曆', size: 'xxs', color: '#AAAAAA', align: 'center', margin: 'sm' },
          ],
        },
      },
    };
    await pushMessage(customerId, [customerMsg], env.LINE_CHANNEL_ACCESS_TOKEN);

    // 老闆的預約確認卡片
    const ownerMsg = {
      type: 'flex',
      altText: `預約完成：${customerName} ${displayStartDate} ${displayTimeRange}`,
      contents: {
        type: 'bubble',
        body: {
          type: 'box', layout: 'vertical', spacing: 'md', paddingAll: 'lg',
          contents: [
            { type: 'text', text: '預約已送出 ✅', weight: 'bold', size: 'xl', color: '#1DB446' },
            { type: 'separator', margin: 'lg' },
            {
              type: 'box', layout: 'vertical', spacing: 'sm', margin: 'lg',
              contents: [
                { type: 'box', layout: 'horizontal', contents: [
                  { type: 'text', text: '客戶', size: 'sm', color: '#888888', flex: 2 },
                  { type: 'text', text: customerName, size: 'sm', flex: 5, wrap: true },
                ]},
                { type: 'box', layout: 'horizontal', contents: [
                  { type: 'text', text: '日期', size: 'sm', color: '#888888', flex: 2 },
                  { type: 'text', text: displayStartDate, size: 'sm', flex: 5, wrap: true },
                ]},
                { type: 'box', layout: 'horizontal', contents: [
                  { type: 'text', text: '時間', size: 'sm', color: '#888888', flex: 2 },
                  { type: 'text', text: displayTimeRange, size: 'sm', flex: 5, wrap: true },
                ]},
              ],
            },
            { type: 'separator', margin: 'lg' },
            { type: 'button', style: 'primary', height: 'sm', margin: 'lg',
              action: { type: 'uri', label: '加入我的日曆', uri: ownerIcsUrl } },
          ],
        },
      },
    };
    await replyMessage(event.replyToken, [ownerMsg], env.LINE_CHANNEL_ACCESS_TOKEN);

    // 記錄
    await logToSheet({
      action: 'log_conversation',
      timestamp: Date.now(),
      customerName,
      userId: customerId,
      role: 'system',
      msgType: 'text',
      content: `【預約】${displayStartDate} ${displayTimeRange}`,
    }, env);
    return;
  }
}

// 取得星期幾的中文
function getWeekday(year, month, day) {
  const days = ['日', '一', '二', '三', '四', '五', '六'];
  const d = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  return days[d.getDay()];
}


// ══════════════════════════════════════════════════
//  處理文字訊息（題庫核心邏輯）
// ══════════════════════════════════════════════════

async function handleText(event, env, workerBaseUrl) {
  const userMsg = event.message.text.trim();
  const userId = event.source.userId;
  const customerName = await getUserDisplayName(userId, env.LINE_CHANNEL_ACCESS_TOKEN);
  const currentState = await getUserState(env, userId);

  let replyText = '';
  let replyOptions = null;
  let photos = [];
  let useWelcomeFlex = false;   // true = 用 Flex Message 按鈕卡片取代 Quick Reply
  let isCarMachineDone = false;
  let newState = null;          // null = 不改變，'active' / 'idle' = 更新 KV
  let carBrand = '';
  let carModel = '';
  let carOem = '';

  // ────────────────────────────────────────
  //  優先級 0：老闆結案（只有老闆能觸發）
  // ────────────────────────────────────────

  // 0a：老闆輸入「結案」→ 顯示進行中案件清單
  if (userMsg === '結案' && userId === env.OWNER_USER_ID) {
    const cases = await getActiveCases(env);
    const entries = Object.entries(cases);
    if (entries.length === 0) {
      await replyMessage(event.replyToken, [{ type: 'text', text: '目前沒有進行中的案件哦 👌' }], env.LINE_CHANNEL_ACCESS_TOKEN);
    } else {
      const options = entries.slice(0, 12).map(([uid, info]) => ({
        label: info.name.slice(0, 20),
        text: `結案｜${uid}`,
      }));
      options.push({ label: '✖ 取消', text: '結案｜取消' });
      await replyMessage(event.replyToken, [
        buildTextMessage('請選擇要結案的客戶 👇', options),
      ], env.LINE_CHANNEL_ACCESS_TOKEN);
    }
    return;
  }

  // 0b：老闆選了要結案的客戶（或取消）
  if (userMsg.startsWith('結案｜') && userId === env.OWNER_USER_ID) {
    const targetUserId = userMsg.replace('結案｜', '');

    // 取消操作
    if (targetUserId === '取消') {
      await replyMessage(event.replyToken, [{ type: 'text', text: '已取消 👌' }], env.LINE_CHANNEL_ACCESS_TOKEN);
      return;
    }
    await setUserState(env, targetUserId, 'idle');
    await removeActiveCase(env, targetUserId);

    // 通知客戶：案件已結束，可以開始新的詢問
    const targetName = await getUserDisplayName(targetUserId, env.LINE_CHANNEL_ACCESS_TOKEN);
    const thankYouMsg = buildWelcomeFlexMessage(
      `${targetName} 感謝您的支持！🎉 案件已完成～\n\n之後有需要歡迎隨時點選下方服務項目 😊`
    );
    await pushMessage(targetUserId, [thankYouMsg], env.LINE_CHANNEL_ACCESS_TOKEN);

    replyText = `✅ 已結案：${targetName}\n客戶會收到感謝通知和新的服務選單`;

    // 記錄結案
    await logToSheet({
      action: 'log_conversation',
      timestamp: Date.now(),
      customerName: targetName,
      userId: targetUserId,
      role: 'system',
      msgType: 'text',
      content: '【結案】老闆已結案，客戶狀態重設為 idle',
    }, env);

    await replyMessage(event.replyToken, [{ type: 'text', text: replyText }], env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }

  // ────────────────────────────────────────
  //  優先級 0c：老闆輸入「約時間」→ 選客戶 → 選日期時間
  // ────────────────────────────────────────
  if (userMsg === '約時間' && userId === env.OWNER_USER_ID) {
    const cases = await getActiveCases(env);
    const entries = Object.entries(cases);
    if (entries.length === 0) {
      await replyMessage(event.replyToken, [{ type: 'text', text: '目前沒有進行中的案件，無法約時間哦 👌' }], env.LINE_CHANNEL_ACCESS_TOKEN);
    } else {
      const options = entries.slice(0, 12).map(([uid, info]) => ({
        label: info.name.slice(0, 20),
        text: `約時間｜${uid}`,
      }));
      options.push({ label: '✖ 取消', text: '約時間｜取消' });
      await replyMessage(event.replyToken, [
        buildTextMessage('請選擇要約時間的客戶 👇', options),
      ], env.LINE_CHANNEL_ACCESS_TOKEN);
    }
    return;
  }

  // 0d：老闆選了客戶 → 彈出日期時間選擇器
  if (userMsg.startsWith('約時間｜') && userId === env.OWNER_USER_ID) {
    const targetUserId = userMsg.replace('約時間｜', '');

    if (targetUserId === '取消') {
      await replyMessage(event.replyToken, [{ type: 'text', text: '已取消 👌' }], env.LINE_CHANNEL_ACCESS_TOKEN);
      return;
    }

    const targetName = await getUserDisplayName(targetUserId, env.LINE_CHANNEL_ACCESS_TOKEN);

    // 用 Flex Message 嵌入 datetime picker 按鈕
    const now = new Date();
    const minDate = now.toISOString().slice(0, 10); // 今天
    const maxDate = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10); // 30天後

    const pickerMsg = {
      type: 'flex',
      altText: `為 ${targetName} 選擇預約時間`,
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'md',
          paddingAll: 'lg',
          contents: [
            {
              type: 'text',
              text: `為 ${targetName} 預約時間`,
              weight: 'bold',
              size: 'lg',
              wrap: true,
            },
            {
              type: 'text',
              text: '第 1 步：選擇開始日期和時間',
              size: 'sm',
              color: '#888888',
              margin: 'sm',
            },
            {
              type: 'button',
              style: 'primary',
              height: 'md',
              margin: 'xl',
              action: {
                type: 'datetimepicker',
                label: '選擇開始時間',
                data: `action=schedule_start&customerId=${targetUserId}`,
                mode: 'datetime',
                min: `${minDate}T08:00`,
                max: `${maxDate}T20:00`,
              },
            },
          ],
        },
      },
    };

    await replyMessage(event.replyToken, [pickerMsg], env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }

  // ────────────────────────────────────────
  //  優先級 1：內裝服務選項 → 詢問車款廠牌
  // ────────────────────────────────────────
  const serviceKey = TRIGGER_TO_KEY[userMsg];
  if (serviceKey) {
    const config = SERVICE_CONFIG[serviceKey];
    replyText = config.brandAsk;
    replyOptions = buildBrandOptions(`內裝｜${serviceKey}｜`);
    newState = 'active';
  }

  // ────────────────────────────────────────
  //  優先級 2：安卓車機 → 進入廠牌選單
  // ────────────────────────────────────────
  else if (userMsg === '安裝安卓車機') {
    replyText = '好的！安卓車機需要先確認車款才能報價哦～\n請問您的車子是什麼廠牌？👇';
    replyOptions = buildBrandOptions('車機｜');
    newState = 'active';
  }

  // ────────────────────────────────────────
  //  優先級 3：內裝｜ 開頭 → 廠牌 / 車型選擇
  // ────────────────────────────────────────
  else if (userMsg.startsWith('內裝｜')) {
    const parts = userMsg.split('｜');
    const sKey = parts[1];
    const config = SERVICE_CONFIG[sKey];

    if (!config) {
      // 無效的 serviceKey
      replyText = '收到您的訊息了！老闆看到會盡快回覆您哦 😊';

    } else if (parts.length === 3) {
      // ── 選了廠牌，顯示車型 ──
      const brand = parts[2];

      if (brand === '其他品牌') {
        replyText = '請選擇您的車子廠牌：';
        replyOptions = Object.keys(OTHER_CAR_BRANDS).map(b => ({
          label: b, text: `內裝｜${sKey}｜${b}`
        }));
        replyOptions.push({ label: '以上都沒有', text: `內裝｜${sKey}｜找不到廠牌` });
      } else if (brand === '找不到廠牌') {
        // 廠牌不在列表 → 跳過車型，直接進拍照流程
        photos = config.photos || [];
        if (config.followUp && config.followUp.length > 0) {
          replyText = `沒問題！\n\n${PHOTO_TIPS}\n\n${config.followUpText}`;
          replyOptions = config.followUp;
        } else {
          replyText = `沒問題！\n\n${PHOTO_TIPS}\n\n拍好直接傳過來就可以囉！😊`;
        }
      } else if (ALL_BRANDS[brand]) {
        replyText = `${brand} 沒問題！請問是哪個車型呢？👇`;
        const models = ALL_BRANDS[brand];
        replyOptions = models.map(m => ({
          label: m, text: `內裝｜${sKey}｜${brand}｜${m}`
        }));
        if (replyOptions.length < 13) {
          replyOptions.push({ label: '以上都沒有', text: `內裝｜${sKey}｜${brand}｜找不到車型` });
        }
      } else {
        // 未知廠牌（不該發生，但防呆）→ 跳過車型，直接進拍照流程
        photos = config.photos || [];
        if (config.followUp && config.followUp.length > 0) {
          replyText = `沒問題！\n\n${PHOTO_TIPS}\n\n${config.followUpText}`;
          replyOptions = config.followUp;
        } else {
          replyText = `沒問題！\n\n${PHOTO_TIPS}\n\n拍好直接傳過來就可以囉！😊`;
        }
      }

    } else if (parts.length >= 4) {
      // ── 選了車型 → 傳參考照片 + 拍照提示 + 追問 ──
      const brand = parts[2];
      const model = parts.slice(3).join('｜');

      if (model === '找不到車型') {
        // 型號不在列表 → 跳過車型，直接進拍照流程
        photos = config.photos || [];
        if (config.followUp && config.followUp.length > 0) {
          replyText = `收到！${brand} 👌\n\n${PHOTO_TIPS}\n\n${config.followUpText}`;
          replyOptions = config.followUp;
        } else {
          replyText = `收到！${brand} 👌\n\n${PHOTO_TIPS}\n\n拍好直接傳過來就可以囉！😊`;
        }
      } else {
        photos = config.photos || [];

        if (config.followUp && config.followUp.length > 0) {
          replyText = `收到！${brand} ${model} 👌\n\n${PHOTO_TIPS}\n\n${config.followUpText}`;
          replyOptions = config.followUp;
        } else {
          replyText = `收到！${brand} ${model} 👌\n\n${PHOTO_TIPS}\n\n拍好直接傳過來就可以囉！😊`;
        }
      }
    }
  }

  // ────────────────────────────────────────
  //  優先級 4：車機｜ 開頭 → 廠牌 / 車型 / OEM 選擇
  // ────────────────────────────────────────
  else if (userMsg.startsWith('車機｜')) {
    const parts = userMsg.split('｜');

    if (parts.length === 2) {
      // ── 選了廠牌，顯示車型 ──
      const brand = parts[1];

      if (brand === '其他品牌') {
        replyText = '請選擇您的車子廠牌：';
        replyOptions = Object.keys(OTHER_CAR_BRANDS).map(b => ({
          label: b, text: `車機｜${b}`
        }));
        replyOptions.push({ label: '以上都沒有', text: '車機｜找不到廠牌' });
      } else if (brand === '找不到廠牌') {
        // 廠牌不在列表 → 跳過車型，直接問 OEM
        replyText = '沒問題！麻煩您幫我拍兩張照片傳過來：\n① 儀表板螢幕\n② 方向盤\n\n另外請問目前的車機是？👇';
        replyOptions = [
          { label: '原廠車機', text: '車機｜其他｜其他｜原廠車機' },
          { label: '已改裝過', text: '車機｜其他｜其他｜已改裝過' },
          { label: '不確定',   text: '車機｜其他｜其他｜不確定' },
        ];
      } else if (ALL_BRANDS[brand]) {
        replyText = `${brand} 沒問題！請問是哪個車型呢？👇`;
        const models = ALL_BRANDS[brand];
        replyOptions = models.map(m => ({
          label: m, text: `車機｜${brand}｜${m}`
        }));
        if (replyOptions.length < 13) {
          replyOptions.push({ label: '以上都沒有', text: `車機｜${brand}｜找不到車型` });
        }
      } else {
        // 未知廠牌（防呆）→ 跳過車型，直接問 OEM
        replyText = '沒問題！麻煩您幫我拍兩張照片傳過來：\n① 儀表板螢幕\n② 方向盤\n\n另外請問目前的車機是？👇';
        replyOptions = [
          { label: '原廠車機', text: '車機｜其他｜其他｜原廠車機' },
          { label: '已改裝過', text: '車機｜其他｜其他｜已改裝過' },
          { label: '不確定',   text: '車機｜其他｜其他｜不確定' },
        ];
      }

    } else if (parts.length === 3) {
      // ── 選了車型 → 請拍照 + 問 OEM ──
      carBrand = parts[1];
      carModel = parts[2];

      if (carModel === '找不到車型') {
        // 型號不在列表 → 跳過車型，直接問 OEM
        replyText = `好的！${carBrand} 的車子 🔧\n\n麻煩您幫我拍兩張照片傳過來：\n① 儀表板螢幕\n② 方向盤\n\n另外請問目前的車機是？👇`;
        replyOptions = [
          { label: '原廠車機', text: `車機｜${carBrand}｜其他｜原廠車機` },
          { label: '已改裝過', text: `車機｜${carBrand}｜其他｜已改裝過` },
          { label: '不確定',   text: `車機｜${carBrand}｜其他｜不確定` },
        ];
      } else {
        replyText = `好的！${carBrand} ${carModel} 🔧\n\n麻煩您幫我拍兩張照片傳過來：\n① 儀表板螢幕\n② 方向盤\n\n另外請問目前的車機是？👇`;
        replyOptions = [
          { label: '原廠車機', text: `車機｜${carBrand}｜${carModel}｜原廠車機` },
          { label: '已改裝過', text: `車機｜${carBrand}｜${carModel}｜已改裝過` },
          { label: '不確定',   text: `車機｜${carBrand}｜${carModel}｜不確定` },
        ];
      }

    } else if (parts.length >= 4) {
      // ── OEM 回答 → 車機詢問完成 ──
      carBrand = parts[1];
      carModel = parts[2];
      carOem = parts.slice(3).join('｜');

      replyText = `好的！${carBrand} ${carModel}（${carOem}），我這邊馬上幫您確認規格跟費用，很快回覆您！💪`;
      isCarMachineDone = true;
    }
  }

  // ────────────────────────────────────────
  //  優先級 5：追問｜ → 服務追問回答
  // ────────────────────────────────────────
  else if (userMsg.startsWith('追問｜')) {
    const parts = userMsg.split('｜');
    const sKey = parts[1];
    const answer = parts.slice(2).join('｜');
    const config = SERVICE_CONFIG[sKey];
    const serviceName = config ? config.name : '';

    replyText = `收到！${answer}，了解了 👌\n\n照片拍好直接傳過來就可以囉，我看完馬上回覆您！`;
  }

  // ────────────────────────────────────────
  //  優先級 6：時程｜ → 急迫性篩選（預約制）
  // ────────────────────────────────────────
  else if (userMsg.startsWith('時程｜')) {
    const urgency = userMsg.replace('時程｜', '');

    if (urgency === '緊急') {
      replyText = '收到！我了解狀況比較緊急 💪\n\n我會盡快看過照片幫您安排，請稍候！\n\n⭐ 最後確認一下，我看完照片後直接在 LINE 上跟您通話說明，方便嗎？😊';
      replyOptions = CONTACT_OPTIONS;
      notifyOwner(
        `🚨 緊急案件！\n👤 ${customerName}\n💬 客戶表示狀況緊急，需要盡快處理\n\n⚡ 請優先查看照片並安排`,
        env, userId
      );
    } else if (urgency === '排隊') {
      replyText = '好的！沒問題 👌 我看過照片後會跟您報價，再幫您安排預約時間。\n\n⭐ 最後確認一下，我看完照片後直接在 LINE 上跟您通話說明，方便嗎？😊';
      replyOptions = CONTACT_OPTIONS;
    } else {
      // 了解費用 → 流程結束
      replyText = '沒問題！費用會依車款和車況有所不同，我看過照片後會先幫您估個大概的價格範圍，完全不用有壓力哦 😊\n\n有需要的時候隨時找我！';
    }
  }

  // ────────────────────────────────────────
  //  優先級 7：聯繫｜ → LINE 聯繫確認
  // ────────────────────────────────────────
  else if (userMsg.startsWith('聯繫｜')) {
    const choice = userMsg.replace('聯繫｜', '');

    if (choice === '好') {
      replyText = '太好了！我看完照片後會直接用 LINE 通話跟您說明，通常一個工作天內會聯繫您哦，感謝您！💪';
    } else {
      replyText = '沒問題！我看完照片後會用文字回覆您報價，通常一個工作天內會回覆您哦 💪';
    }
  }

  // ────────────────────────────────────────
  //  優先級 8：不方便拍照 → 詢問是否軍職
  // ────────────────────────────────────────
  else if (userMsg === '不方便拍照') {
    replyText = '沒問題！請問方便讓我了解一下原因嗎？這樣我比較好幫您安排 😊';
    replyOptions = [
      { label: '軍職不便',   text: '拍照｜軍職' },
      { label: '其他原因',   text: '拍照｜其他' },
    ];
  }

  // ────────────────────────────────────────
  //  優先級 8-2：拍照｜ → 軍職 / 其他原因
  // ────────────────────────────────────────
  else if (userMsg.startsWith('拍照｜')) {
    const reason = userMsg.replace('拍照｜', '');

    if (reason === '軍職') {
      replyText = '了解！軍職確實不方便拍照也不方便跑一趟 💪\n\n我會請老闆盡快直接在 LINE 上聯繫您，幫您處理！請放心 😊';
      notifyOwner(
        `🚨 軍職客戶 - 請盡快聯繫！\n👤 ${customerName}\n💬 軍職，無法拍照也無法到現場\n\n⚡ 請立即主動聯繫客戶`,
        env, userId
      );
    } else {
      replyText = '沒問題！您可以直接用文字描述一下車子目前的狀況，我先幫您初步評估～\n\n或者直接開車過來讓我現場看也可以哦！\n\n📍 高雄市鳥松區中正路101號\nhttps://maps.google.com/?q=高雄市鳥松區中正路101號';
      notifyOwner(
        `📋 客戶詢問\n👤 ${customerName}\n💬 不方便拍照，需要文字溝通或到店評估`,
        env, userId
      );
    }
  }

  // ────────────────────────────────────────
  //  優先級 9：直接到店評估
  // ────────────────────────────────────────
  else if (userMsg === '直接到店評估') {
    replyText = '歡迎直接過來！😊\n\n📍 高雄市鳥松區中正路101號\n（近文山派出所、長庚醫院）\n\n🕘 營業時間：週一至週日 09:00–18:00\n\n💡 建議來之前先傳個訊息跟我說一下，確認我在店裡哦！\nhttps://maps.google.com/?q=高雄市鳥松區中正路101號';
    notifyOwner(
      `🏪 客戶想到店\n👤 ${customerName}\n💬 想直接到店評估`,
      env, userId
    );
  }

  // ────────────────────────────────────────
  //  優先級 10：觸發詞（只在 idle 時才顯示選單）
  //  active 時一律不彈選單，避免干擾老闆與客戶的對話
  // ────────────────────────────────────────
  else if (currentState === 'idle' && (
    RESET_TRIGGERS.some(t => userMsg.toLowerCase().includes(t)) ||
    GREETING_TRIGGERS.some(t => userMsg.toLowerCase().includes(t))
  )) {
    replyText = getWelcomeText(customerName);
    useWelcomeFlex = true;
  }

  // ────────────────────────────────────────
  //  優先級 11：固定關鍵字
  // ────────────────────────────────────────
  else if (Object.keys(KEYWORD_REPLIES).some(k => userMsg.includes(k))) {
    const key = Object.keys(KEYWORD_REPLIES).find(k => userMsg.includes(k));
    replyText = KEYWORD_REPLIES[key];
  }

  // ────────────────────────────────────────
  //  優先級 12：預約 / 報價相關
  // ────────────────────────────────────────
  else if (currentState === 'idle' && /預約|報價|價格|費用|多少錢/.test(userMsg)) {
    replyText = '費用會依車況不同而異哦！請問您的車子目前遇到什麼狀況呢？先選一下，我馬上幫您評估 👇';
    useWelcomeFlex = true;
  }

  // ────────────────────────────────────────
  //  預設：依狀態決定行為
  //  idle → 顯示服務選單（可能是新用戶或案件已結束）
  //  active → 轉給老闆（正在對話中）
  // ────────────────────────────────────────
  else {
    if (currentState === 'idle') {
      replyText = getWelcomeText(customerName);
      useWelcomeFlex = true;
    } else {
      replyText = '收到您的訊息了！老闆看到會盡快回覆您哦 😊';
    }
  }

  // ── 更新 KV 狀態 + 案件清單 ──
  if (newState) {
    await setUserState(env, userId, newState);
    if (newState === 'active') {
      await addActiveCase(env, userId, customerName);
    }
  }

  // ── 組裝 LINE 回覆訊息（上限 5 則）──
  const messages = [];

  if (useWelcomeFlex) {
    // 用 Flex Message 按鈕卡片呈現服務選單
    messages.push(buildWelcomeFlexMessage(replyText));
  } else {
    // 參考照片放前面，讓客戶先看到
    for (const url of photos.slice(0, 3)) {
      messages.push(buildImageMessage(url));
    }
    // 文字訊息（含快速選項按鈕）放最後
    messages.push(buildTextMessage(replyText, replyOptions));
  }

  // LINE Reply API 上限 5 則訊息
  await replyMessage(event.replyToken, messages.slice(0, 5), env.LINE_CHANNEL_ACCESS_TOKEN);

  // ── 車機詢問完成：記錄 + 通知老闆 ──
  if (isCarMachineDone) {
    logToSheet({
      action: 'log_car_machine',
      timestamp: event.timestamp,
      customerName,
      userId,
      brand: carBrand,
      model: carModel,
      oem: carOem,
    }, env);

    notifyOwner(
      `🔧 車機詢問\n👤 ${customerName}\n🚗 ${carBrand} ${carModel}\n📋 車機：${carOem}\n\n請確認規格後回覆客戶`,
      env, userId
    );
  }

  // ── 記錄到 Google Sheets ──
  // 客戶訊息
  await logToSheet({
    action: 'log_conversation',
    timestamp: event.timestamp,
    customerName,
    userId,
    role: 'customer',
    msgType: 'text',
    content: userMsg,
  }, env);

  // Bot 回覆（含選項內容）
  const logOptions = useWelcomeFlex ? WELCOME_OPTIONS : replyOptions;
  const logContent = buildLogContent(replyText, logOptions);
  const photoNote = photos.length > 0 ? `\n\n（附參考照片 ${photos.length} 張）` : '';
  await logToSheet({
    action: 'log_conversation',
    timestamp: Date.now(),
    customerName,
    userId,
    role: 'bot',
    msgType: photos.length > 0 ? 'text+image' : 'text',
    content: logContent + photoNote,
  }, env);
}


// ══════════════════════════════════════════════════
//  批次處理同一用戶的多張照片（只回覆一次）
// ══════════════════════════════════════════════════

async function handleImageBatch(imageEvents, env) {
  try {
    const firstEvent = imageEvents[0];
    const userId = firstEvent.source.userId;
    const customerName = await getUserDisplayName(userId, env.LINE_CHANNEL_ACCESS_TOKEN);

    const now = Date.now();
    const lastReply = recentImageReplies.get(userId) || 0;
    const shouldReply = (now - lastReply) > IMAGE_REPLY_COOLDOWN;

    if (shouldReply) {
      const urgencyReplyText = '收到您的照片了！😊 快完成囉，再幫我回答一下～\n\n請問目前車子的狀況急不急呢？👇';
      await replyMessage(firstEvent.replyToken, [
        buildTextMessage(urgencyReplyText, URGENCY_OPTIONS),
      ], env.LINE_CHANNEL_ACCESS_TOKEN);

      recentImageReplies.set(userId, now);

      notifyOwner(
        `📸 客戶照片通知\n👤 ${customerName}\n📷 ${imageEvents.length} 張照片\n\n請到 LINE Official Account 查看並回覆`,
        env, userId
      );
    }

    // 存照片到 Google Drive
    if (env.GAS_URL) {
      const savePromises = imageEvents.map(event =>
        postToGAS(env.GAS_URL, {
          action: 'save_photo',
          userId,
          customerName,
          messageId: event.message.id,
          timestamp: event.timestamp,
          accessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
        }).catch(err => console.error('Photo save error:', err.message))
      );
      await Promise.all(savePromises);
    }

    // 記錄對話
    await logToSheet({
      action: 'log_conversation',
      timestamp: firstEvent.timestamp,
      customerName,
      userId,
      role: 'customer',
      msgType: 'image',
      content: `（上傳 ${imageEvents.length} 張照片）`,
    }, env);

    if (shouldReply) {
      const urgencyLogText = '收到您的照片了！😊 快完成囉，再幫我回答一下～\n\n請問目前車子的狀況急不急呢？\n\n【選項】\n1. 急！盡快處理\n2. 不急，排隊就好\n3. 先了解費用';
      await logToSheet({
        action: 'log_conversation',
        timestamp: now,
        customerName,
        userId,
        role: 'bot',
        msgType: 'text',
        content: urgencyLogText,
      }, env);
    }

    // 清理過期冷卻記錄
    for (const [uid, ts] of recentImageReplies) {
      if (now - ts > 60000) recentImageReplies.delete(uid);
    }

  } catch (err) {
    console.error('handleImageBatch error:', err.message);
  }
}


// ══════════════════════════════════════════════════
//  驗證 LINE 簽名（HMAC-SHA256）
// ══════════════════════════════════════════════════

async function verifySignature(body, signature, channelSecret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return signature === expected;
}


// ══════════════════════════════════════════════════
//  取得客戶 LINE 名稱
// ══════════════════════════════════════════════════

async function getUserDisplayName(userId, accessToken) {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) {
      const profile = await res.json();
      return profile.displayName || '未知客戶';
    }
  } catch (e) {}
  return '未知客戶';
}



// ══════════════════════════════════════════════════
//  推送通知給老闆
// ══════════════════════════════════════════════════

async function notifyOwner(text, env, customerUserId) {
  if (!env.OWNER_USER_ID) return;
  // 如果觸發者就是老闆本人，跳過通知（避免推播蓋掉 Quick Reply）
  if (customerUserId && customerUserId === env.OWNER_USER_ID) return;

  const messages = [{ type: 'text', text }];

  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to: env.OWNER_USER_ID,
      messages,
    }),
  });
}


// ══════════════════════════════════════════════════
//  記錄對話到 Google Sheets
// ══════════════════════════════════════════════════

async function logToSheet(data, env) {
  if (!env.GAS_URL) return;
  try {
    await postToGAS(env.GAS_URL, data);
  } catch (err) {
    console.error('logToSheet error:', err.message);
  }
}


// ══════════════════════════════════════════════════
//  POST 到 Google Apps Script（處理 302 重新導向）
// ══════════════════════════════════════════════════

async function postToGAS(url, data) {
  let res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    redirect: 'manual',
  });

  if (res.status === 302 || res.status === 301 || res.status === 307) {
    const redirectUrl = res.headers.get('Location');
    if (redirectUrl) {
      res = await fetch(redirectUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    }
  }

  return res;
}


// ══════════════════════════════════════════════════
//  發送回覆訊息
// ══════════════════════════════════════════════════

async function replyMessage(replyToken, messages, accessToken) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
}

// 主動推播訊息給指定用戶（不需要 replyToken）
async function pushMessage(userId, messages, accessToken) {
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ to: userId, messages }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('pushMessage error:', res.status, err);
    }
  } catch (e) {
    console.error('pushMessage exception:', e.message);
  }
}
