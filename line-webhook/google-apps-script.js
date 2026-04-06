/**
 * Google Apps Script - LINE 照片存檔 + 記錄表 + 網站後台 API
 *
 * 功能：
 *   1. 由 GAS 直接從 LINE 下載照片存入 Google Drive（Worker 只傳 messageId）
 *   2. 照片記錄表：同天同客戶合併一筆，照片連結換行分隔
 *   3. 對話記錄表：所有訊息往來紀錄
 *   4. 網站後台 API：管理服務照片與影片列表
 *
 * 使用方式：
 *   1. 前往 https://script.google.com 建立新專案
 *   2. 將此程式碼貼上
 *   3. 修改下方 FOLDER_ID 和 SHEET_ID
 *   4. 部署為「網路應用程式」，執行身分「我」，存取權「所有人」
 *   5. 複製部署網址，貼到 Cloudflare Worker 的 GAS_URL 環境變數
 *   6. 首次使用後台：執行 initWebsiteSheets() 建立工作表 + 匯入現有資料
 *   7. 在「指令碼屬性」設定 ADMIN_PASSWORD（專案設定 → 指令碼屬性 → 新增）
 */

// ★ 修改這裡：換成你的 Google Drive 資料夾 ID
const FOLDER_ID = '1h1zv-DhIWaLbAJydxITEmIPAuCrww0M3';

// ★ 修改這裡：換成你的 Google Sheets ID
const SHEET_ID = '1dm_yDTthz6OAWvRS22OobsDgviavEQZDn-gwVJ9lZEs';

// ★ 允許登入後台的 Gmail 帳號
const ALLOWED_EMAILS = [
  'chienyuan1126@gmail.com',
  'a0938122361@gmail.com',
  'arwen10311031@gmail.com'
];

// ★ 網站服務照片用的 Google Drive 資料夾 ID（新建一個放服務照片）
const WEBSITE_PHOTOS_FOLDER_ID = '1paTvjuxE44dkxk2xosuZiwASCLAyAOwY'; // ← 填入你的資料夾 ID，留空則用 FOLDER_ID


// ══════════════════════════════════════════
//  doGet — 公開讀取（前台網站用）
// ══════════════════════════════════════════

function doGet(e) {
  const action = (e.parameter || {}).action;

  if (action === 'get_config') {
    return corsJson(getPublicConfig());
  }

  // 預設：顯示後台管理頁面（addMetaTag 讓 GAS iframe 支援手機 RWD）
  return HtmlService.createHtmlOutputFromFile('admin')
    .setTitle('後台管理 | I LUV尹澤鎂研')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


// ══════════════════════════════════════════
//  doPost — 分流處理
// ══════════════════════════════════════════

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    // ── LINE Bot 相關 ──
    if (data.action === 'log_conversation') {
      return logConversation(data);
    } else if (data.action === 'save_photo') {
      return savePhoto(data);
    } else if (data.action === 'log_car_machine') {
      return logCarMachine(data);
    } else if (data.action === 'create_appointment') {
      return createAppointment(data);
    }

    // ── 後台管理 API（透過 google.script.run 呼叫，這裡保留給外部需求）──
    else if (data.action === 'admin_save_photos') {
      var auth1 = checkAuth();
      if (!auth1.ok) return corsJson({ status: 'error', message: auth1.message });
      return corsJson(adminSavePhotos(data));
    } else if (data.action === 'admin_save_videos') {
      var auth2 = checkAuth();
      if (!auth2.ok) return corsJson({ status: 'error', message: auth2.message });
      return corsJson(adminSaveVideos(data));
    }

    return jsonResponse({ status: 'error', message: 'unknown action' });

  } catch (err) {
    console.error('❌ 錯誤：', err.toString());
    return jsonResponse({ status: 'error', message: err.toString() });
  }
}


// ══════════════════════════════════════════
//  後台驗證
//  ★ 部署時選「執行身分：我」「存取權：所有人」
//  ★ 安全機制：只有知道網址的人 + 輸入正確 PIN 才能進入
// ══════════════════════════════════════════

var ADMIN_PIN = '2361';  // ← 管理員共用 PIN 碼，可自行修改

function checkPin(pin) {
  if (pin !== ADMIN_PIN) {
    return { ok: false, message: 'PIN 碼錯誤' };
  }
  return { ok: true };
}


// ══════════════════════════════════════════
//  給 admin.html 用的 google.script.run 包裝
// ══════════════════════════════════════════

function clientCheckPin(pin) {
  var result = checkPin(pin);
  if (!result.ok) return { status: 'error', message: result.message };
  return { status: 'ok' };
}

function clientGetConfig(pin) {
  var check = checkPin(pin);
  if (!check.ok) return { status: 'error', message: check.message };
  var config = getPublicConfig();
  config.status = 'ok';
  return config;
}

function clientSavePhotos(pin, services) {
  var check = checkPin(pin);
  if (!check.ok) return { status: 'error', message: check.message };
  return adminSavePhotos({ services: services });
}

function clientSaveVideos(pin, videos) {
  var check = checkPin(pin);
  if (!check.ok) return { status: 'error', message: check.message };
  return adminSaveVideos({ videos: videos });
}

function clientUploadPhoto(pin, base64, filename, serviceIndex) {
  var check = checkPin(pin);
  if (!check.ok) return { status: 'error', message: check.message };
  return adminUploadPhoto({ base64: base64, filename: filename, serviceIndex: serviceIndex });
}

function clientDeletePhoto(pin, fileId) {
  var check = checkPin(pin);
  if (!check.ok) return { status: 'error', message: check.message };
  return adminDeletePhoto({ fileId: fileId });
}

// ── 客戶筆記：儲存（以客戶名稱為 key，一人一筆記）──
function clientSaveNote(pin, customerName, note) {
  var check = checkPin(pin);
  if (!check.ok) return { status: 'error', message: check.message };

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName('客戶筆記');
  if (!sheet) {
    sheet = ss.insertSheet('客戶筆記');
    sheet.getRange(1, 1, 1, 3).setValues([['客戶名稱', '筆記', '更新時間']]);
    sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
  }

  // 找是否已有該客戶的筆記
  var lastRow = sheet.getLastRow();
  var existingRow = -1;
  if (lastRow > 1) {
    var names = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < names.length; i++) {
      if (String(names[i][0]) === customerName) { existingRow = i + 2; break; }
    }
  }

  var now = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
  if (existingRow > 0) {
    sheet.getRange(existingRow, 2).setValue(note);
    sheet.getRange(existingRow, 3).setValue(now);
  } else {
    sheet.appendRow([customerName, note, now]);
  }
  return { status: 'ok' };
}

// ── 客戶照片：搜尋（照片按客戶分組，一人一筆記）──
function clientSearchPhotos(pin, keyword) {
  var check = checkPin(pin);
  if (!check.ok) return { status: 'error', message: check.message };

  var ss = SpreadsheetApp.openById(SHEET_ID);

  // 讀取照片
  var photoSheet = ss.getSheetByName('客戶照片');
  if (!photoSheet || photoSheet.getLastRow() <= 1) return { status: 'ok', customers: [] };
  var rows = photoSheet.getRange(2, 1, photoSheet.getLastRow() - 1, 7).getValues();

  // 讀取筆記
  var noteMap = {};
  var noteSheet = ss.getSheetByName('客戶筆記');
  if (noteSheet && noteSheet.getLastRow() > 1) {
    var noteRows = noteSheet.getRange(2, 1, noteSheet.getLastRow() - 1, 2).getValues();
    for (var n = 0; n < noteRows.length; n++) {
      noteMap[String(noteRows[n][0])] = String(noteRows[n][1]);
    }
  }

  // 按客戶分組
  var grouped = {};
  for (var i = 0; i < rows.length; i++) {
    var time = rows[i][0];
    var name = String(rows[i][1]);
    var service = String(rows[i][3]);
    var thumbUrl = String(rows[i][5]);
    // 縮圖 URL 加 =s0 取得原尺寸大圖
    var photoUrl = thumbUrl.indexOf('lh3.googleusercontent.com') > -1
      ? thumbUrl + '=s0'
      : thumbUrl;

    var timeStr = '';
    if (time instanceof Date) {
      timeStr = Utilities.formatDate(time, 'Asia/Taipei', 'yyyy-MM-dd HH:mm');
    } else {
      timeStr = String(time);
    }

    if (!grouped[name]) {
      grouped[name] = { name: name, services: [], photos: [], latestTime: timeStr };
    }
    grouped[name].photos.push({ thumbUrl: thumbUrl, photoUrl: photoUrl });
    grouped[name].latestTime = timeStr; // 最後一張的時間
    if (service && grouped[name].services.indexOf(service) === -1) {
      grouped[name].services.push(service);
    }
  }

  // 轉成陣列，掛上筆記
  var results = [];
  for (var key in grouped) {
    var g = grouped[key];
    g.note = noteMap[key] || '';
    g.serviceText = g.services.join('、');

    // 模糊搜尋
    if (keyword && keyword.trim()) {
      var kw = keyword.trim().toLowerCase();
      var searchText = (g.name + ' ' + g.serviceText + ' ' + g.note).toLowerCase();
      if (searchText.indexOf(kw) === -1) continue;
    }
    results.push(g);
  }

  // 最新的在前面
  results.sort(function(a, b) { return b.latestTime.localeCompare(a.latestTime); });
  return { status: 'ok', customers: results };
}


// ══════════════════════════════════════════
//  公開讀取：取得服務照片 + 影片列表
// ══════════════════════════════════════════

function getPublicConfig() {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  // 服務照片
  const photoSheet = ss.getSheetByName('網站服務照片');
  let services = [];
  if (photoSheet && photoSheet.getLastRow() > 1) {
    const rows = photoSheet.getRange(2, 1, photoSheet.getLastRow() - 1, 3).getValues();
    const map = {};
    for (const [idx, title, photosJson] of rows) {
      const i = Number(idx);
      if (!map[i]) map[i] = { index: i, title: String(title), photos: [] };
      try {
        const arr = JSON.parse(photosJson);
        if (Array.isArray(arr)) map[i].photos = arr;
      } catch (e) {
        if (String(photosJson).trim()) map[i].photos = [String(photosJson)];
      }
    }
    services = Object.values(map).sort((a, b) => a.index - b.index);
  }

  // 影片列表
  const videoSheet = ss.getSheetByName('網站影片');
  let videos = [];
  if (videoSheet && videoSheet.getLastRow() > 1) {
    const rows = videoSheet.getRange(2, 1, videoSheet.getLastRow() - 1, 1).getValues();
    videos = rows.map(r => String(r[0]).trim()).filter(Boolean);
  }

  return { status: 'ok', services, videos };
}


// ══════════════════════════════════════════
//  後台：儲存服務照片
// ══════════════════════════════════════════

function adminSavePhotos(data) {
  // data.services = [{ index: 0, title: '...', photos: ['url1','url2',...] }, ...]
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName('網站服務照片');
  if (!sheet) {
    sheet = ss.insertSheet('網站服務照片');
    sheet.getRange(1, 1, 1, 3).setValues([['服務編號', '服務名稱', '照片列表(JSON)']]);
    sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
  }

  // 清除舊資料，寫入新資料
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).clearContent();
  }

  const rows = data.services.map(s => [s.index, s.title, JSON.stringify(s.photos || [])]);
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 3).setValues(rows);
  }

  return { status: 'ok', message: '照片已儲存' };
}


// ══════════════════════════════════════════
//  後台：儲存影片列表
// ══════════════════════════════════════════

function adminSaveVideos(data) {
  // data.videos = ['id1', 'id2', ...]
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName('網站影片');
  if (!sheet) {
    sheet = ss.insertSheet('網站影片');
    sheet.getRange(1, 1).setValue('影片ID');
    sheet.getRange(1, 1).setFontWeight('bold');
  }

  // 清除舊資料，寫入新資料
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).clearContent();
  }

  const rows = data.videos.map(id => [id]);
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 1).setValues(rows);
  }

  return { status: 'ok', message: '影片已儲存' };
}


// ══════════════════════════════════════════
//  後台：上傳照片到 Google Drive
// ══════════════════════════════════════════

function adminUploadPhoto(data) {
  // data.base64 = base64 encoded image
  // data.filename = optional filename
  // data.serviceIndex = which service this photo belongs to

  const folderId = WEBSITE_PHOTOS_FOLDER_ID || FOLDER_ID;
  const parentFolder = DriveApp.getFolderById(folderId);

  // 建立「網站服務照片」子資料夾
  const subFolder = getOrCreateFolder(parentFolder, '網站服務照片');

  const bytes = Utilities.base64Decode(data.base64);
  const blob = Utilities.newBlob(bytes, 'image/jpeg', data.filename || ('photo_' + Date.now() + '.jpg'));
  const file = subFolder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  // 產生直接連結
  const fileId = file.getId();
  const directUrl = 'https://lh3.googleusercontent.com/d/' + fileId;

  return { status: 'ok', url: directUrl, fileId: fileId };
}


// ══════════════════════════════════════════
//  後台：刪除 Google Drive 照片
// ══════════════════════════════════════════

function adminDeletePhoto(data) {
  // data.fileId = Google Drive file ID
  if (data.fileId) {
    try {
      DriveApp.getFileById(data.fileId).setTrashed(true);
    } catch (e) {
      // 檔案可能不存在或不是 Drive 上的，忽略
    }
  }
  return { status: 'ok' };
}


// ══════════════════════════════════════════
//  初始化：匯入現有資料到新工作表（執行一次）
// ══════════════════════════════════════════

function initWebsiteSheets() {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  // ── 服務照片表 ──
  let photoSheet = ss.getSheetByName('網站服務照片');
  if (!photoSheet) {
    photoSheet = ss.insertSheet('網站服務照片');
    photoSheet.getRange(1, 1, 1, 3).setValues([['服務編號', '服務名稱', '照片列表(JSON)']]);
    photoSheet.getRange(1, 1, 1, 3).setFontWeight('bold');
  }

  // 匯入 index.html 上的現有照片
  const currentServices = [
    { index: 0, title: '內裝拆洗大整理', photos: ['1/S__9330757_0.jpg','1/S__9330758_0.jpg','1/S__9330759_0.jpg','1/S__9330760_0.jpg','1/S__9330770_0.jpg','1/S__9330771_0.jpg','1/S__9330809_0.jpg','1/S__9330810_0.jpg','1/S__9330811_0.jpg','1/S__9330812_0.jpg','1/S__9330813_0.jpg'] },
    { index: 1, title: '內裝不拆清洗', photos: ['2/S__9330816_0.jpg','2/S__9330817_0.jpg','2/S__9330818_0.jpg','2/S__9330819_0.jpg','2/S__9330820_0.jpg','2/S__9330821_0.jpg'] },
    { index: 2, title: '內裝深層清潔', photos: [] },
    { index: 3, title: '頂棚絨布．坐椅皮革舊翻新', photos: ['4/S__9330774_0.jpg','4/S__9330775_0.jpg','4/S__9330776_0.jpg','4/S__9330777_0.jpg','4/S__9330778_0.jpg','4/S__9330779_0.jpg','4/S__9330780_0.jpg','4/S__9330781_0.jpg','4/S__9330782_0.jpg','4/S__9330783_0.jpg','4/S__9330803_0.jpg','4/S__9330804_0.jpg','4/S__9330805_0.jpg','4/S__9330806_0.jpg','4/S__9330833_0.jpg','4/S__9330834_0.jpg','4/S__9330835_0.jpg','4/S__9330836_0.jpg'] },
    { index: 4, title: '皮革局部受傷修復還原', photos: ['5/S__9330786_0.jpg','5/S__9330787_0.jpg','5/S__9330788_0.jpg','5/S__9330789_0.jpg','5/S__9330790_0.jpg'] },
    { index: 5, title: '白色內裝／淺色抗污處理', photos: [] },
    { index: 6, title: '安卓機．行車記錄器安裝', photos: ['7/S__9330795_0.jpg','7/S__9330796_0.jpg','7/S__9330797_0.jpg','7/S__9330798_0.jpg','7/S__9330824_0.jpg','7/S__9330825_0.jpg','7/S__9330826_0.jpg','7/S__9330827_0.jpg','7/S__9330828_0.jpg','7/S__9330829_0.jpg','7/S__9330830_0.jpg'] },
  ];

  // 只在表是空的時候匯入
  if (photoSheet.getLastRow() <= 1) {
    const rows = currentServices.map(s => [s.index, s.title, JSON.stringify(s.photos)]);
    photoSheet.getRange(2, 1, rows.length, 3).setValues(rows);
    Logger.log('✅ 服務照片已匯入 ' + rows.length + ' 筆');
  }

  // ── 影片表 ──
  let videoSheet = ss.getSheetByName('網站影片');
  if (!videoSheet) {
    videoSheet = ss.insertSheet('網站影片');
    videoSheet.getRange(1, 1).setValue('影片ID');
    videoSheet.getRange(1, 1).setFontWeight('bold');
  }

  // 匯入現有影片 ID
  if (videoSheet.getLastRow() <= 1) {
    const allVideoIds = [
      "FzmEcoa-XYc","kwWg8U0yLos","S8XBl6ujtxM","FY7qe_ql8k0","UdMym_hiHZM","qDRK3DNNTXM","YXYCmw78ITc","3pEsV4j29_E","sWk-OZSZ4ug","i7ZUovo8qIA",
      "ydnvRe2jP3c","KGc5ZgozA5U","y1npaxDGtkg","r4Vx1CKIWeY","rL4_9v96gJ0","MFI-o6DR6UY","ljU67cpeSgw","GKlURjYOvGs","MfR_tEb3VK0","coCYA0YzLn4",
      "3liObdUgmkc","ERSS4olJ_rE","D6OU0Iu9UiA","m6sCACT04R0","rj-Fx943u-g","GTWrBwja12U","2Qs4NVWcIV8","otqNZlCz_io","krNxqIZWzj8","dOgxFz4Is_Q",
      "IHD0KYtlHi4","vd3y_VYfByQ","yYpDvjSMl5M","clTjpIsUnIw","oANI96_He6k","sJYfIFdS0vU","HgLzWOPAwR8","iiszt6ite48","rpSXMyDfHU4","B_dXs1x8E34",
      "RSH1ifWOC8w","FNSUpBFbJRU","KcDW_g0Q050","RxlvQkXGimY","Phw4uYmbEnY","6n_IY9fWxvg","2jvIo_-IMlk","F6lyN44fKPE",
      "w9NpCWRQgAI","PrOZWm0puS0","YS3ZUz2tilI","oj6QI-tOI9E","NoDiyOF-wYE","7DIIn7njz5Y","0mnTfxJYwc8","Js91ORmqjto","NHUM8Onrkl8","DCEHQ7utPNw",
      "B9VSRtUH-_4","M3WMLUieZEE","iPJIaYduslA","mkmVRiiTwk0","mz2d_JhJJlM","TENfRXaWyTM","VAIwl5fjiig","PfFHqsqNJmA","Obnj3UCi9lc","D7vKPjdRNLw",
      "Dmz_kM-ibKM","Uy6fprQJKdY","P7VCmqf47rk","ylS7lHAOkWQ","LlhHqiiPfuU","czqgBCs8qJw","E2VtZz9vXs0","KrfiX5Y5Vo4","bckqUBHaxCI","29IfOB8GUag",
      "uaPmZqUOKZk","7n-g2n0MeQ0","yV2Pbd0oKkc","-xBYlblOo24","0lM5QlwAvJI","A0pELjb7EmM","TF0G34w0MxQ","e9SXyGSsLsY","klf0lrgkrlY","pzuhlEYn5Og",
      "9tYn9MFvBZI","RxSwySvQcXM","_SkvSFpY92k","8G7EphB98kY","nHvYnGHx2KQ","2TBxbIZ-zTM","TTL9ap9pQ2c","muweX6mDkhc","H3_AqvzcIqQ","Jae_4DU2Tqw",
      "twNzIWpqixc","P1Gb7fnf6Qo","5Dngoz-TBhE","4ZrvY89H8dE","cuINoxBihVE","oIm3IM5-TG4","KW8J9WWjVMc","Qg6W64QsAWA","qkytXJfCfqY","iblfLanTUaE",
      "IYM690UlA0Y","Axk49qoHcCE","X0znmeWJtig","vnU9cHX8aos","x8cw9pytkwY","OpsQO7BPucE","wTiKBjDCL48","oAvDf5GcSwQ","cYXIffury3U","M4uWK51ekas",
      "v2rUV0IRh2E","NRBbF0BpzMU","XdXRDSJzosI","7ryIzSO5yos","3bbO_Q-SRIk","eP9E1z8VnLo","hdd4axPBGf0","62QlhiWcJ_w","Mv8qE_X7_zA","jaLDJKqmNN8",
      "-CRytXuFNg4","Vjj59I5Voig","rlSmsZi2HTQ","bximiSe1scU","rC_HwbJhSW8","LMZliV6Mvfg","dtI-mfOGp8o","dZ1pd-awVKQ","6qgxk_Ildu8","XEpCAjyliL0",
      "YBdfu6VJnmc","mEaWwYYqjpA","azLxlRSEEJo","1nb5mLjDoHQ","uYbWl8j33zA","bc9Jq77mEOc","HcSsgjk5zmg","eo0o3YCM2uQ","k2k4XR5u_gg","fk-3IMRi-IE",
      "97Qo0KNQtLw","GXa33Z_yUQw","MT-oNDaMo5A","66VJ6iMqyXU","h93B3mrHtOg","RuZkGblKG0w","QJ7yez2EE_E","jnX0hXzv_7Y","2xcKbSs5rIk","KR4m1ouN1IE",
      "Z5zY-Z_ZfqU","tq1Rc94-7RI","8sx06FO_iKY","gD_JTrpNQ0g","lQTD9No8xsM","XdONVj5fZeg","CHYxRy0RV1I","6HvXSF8nXsM","T6J3qL0l40Y","di8P7L9WCvs",
      "v8R9HPWAut8","d-sx1KQm5SA","-NPV54hGbRM","OkGxY6_r28o","QQtRESCCYyI","x4WkUTxvEDE","Jh6ZbWBGbOo","ydgU6c03tK8","VlaRVFPc1UM","QlWqHngKJQs",
      "wYuWnIuDbeI","PO_Olo5aOvg","x1LDhAFOswk","jGhKUy-APuA","_NuvEBLluTE","OfdoH5euvCY","meShIJCoI3c","zcF_-XJwnwI","N3oJj2EV56k","dlcpftbPFqA",
      "rVd1kmrFShg","Itu85KLtcBY","TuZ3gK5CZYg","iKqh8MFO6x8","hQFJl7NyTuA","6LE_qyf2-DY","u1uyTbFHNu4","h2SwCKv0yx8","NAEKWLRqI7Y","HKK0teel6Lc",
      "1S5PtViDKuo","S17hSS0yLKg","z1ezmO4_NeQ","oK_hoPxYgDQ","0cBzD1ixwBw","w04MFrDIp9M","KcatZzwF5R4","8m6fllPOgAc","PjA1VioblpE","Y838PtolbgM",
      "UrtTX2RuYz8","a9pCVBB3-4E","HI-w7snEvMY","2Q2BUS4hX8Q","CJglX8i8KKg","mD9Gf_tvcYw","kMXHgz6tiaI","m8QZdqEIq-w","936w2XTvf_I","TsPE_G7IzYA",
      "rQ_0WcvBNAA","NUALFxpgejI","eXazelGbPKE","XxTFsDqSujg","OkariTTRiI8","LVf0PLVKn0Y","3c2eD8LfkTg","xO5CjSj4BXA","JHYqWOl-YMs","PmMGkRjE-uM",
      "3Iq1DFCG1t8","Phr0xM8lMlw","JQs5FkZ4Zuw","GVEGq2clLZ4","IWctQQlIPdY","QcReF-GO3fQ","nKj7tJQ4gbc","yxhED67MiWs","-pl4Q_DokEM",
    ];
    const rows = allVideoIds.map(id => [id]);
    videoSheet.getRange(2, 1, rows.length, 1).setValues(rows);
    Logger.log('✅ 影片已匯入 ' + rows.length + ' 筆');
  }

  Logger.log('✅ 網站工作表初始化完成');
}


// ══════════════════════════════════════════
//  一次性遷移：把網站上的照片下載到 Google Drive
//  ★ 在 GAS 編輯器裡手動執行一次就好
// ══════════════════════════════════════════

function migratePhotos() {
  const folderId = WEBSITE_PHOTOS_FOLDER_ID || FOLDER_ID;
  const parentFolder = DriveApp.getFolderById(folderId);
  const photoFolder = getOrCreateFolder(parentFolder, '網站服務照片');

  const currentServices = [
    { index: 0, title: '內裝拆洗大整理', photos: ['1/S__9330757_0.jpg','1/S__9330758_0.jpg','1/S__9330759_0.jpg','1/S__9330760_0.jpg','1/S__9330770_0.jpg','1/S__9330771_0.jpg','1/S__9330809_0.jpg','1/S__9330810_0.jpg','1/S__9330811_0.jpg','1/S__9330812_0.jpg','1/S__9330813_0.jpg'] },
    { index: 1, title: '內裝不拆清洗', photos: ['2/S__9330816_0.jpg','2/S__9330817_0.jpg','2/S__9330818_0.jpg','2/S__9330819_0.jpg','2/S__9330820_0.jpg','2/S__9330821_0.jpg'] },
    { index: 2, title: '內裝深層清潔', photos: [] },
    { index: 3, title: '頂棚絨布．坐椅皮革舊翻新', photos: ['4/S__9330774_0.jpg','4/S__9330775_0.jpg','4/S__9330776_0.jpg','4/S__9330777_0.jpg','4/S__9330778_0.jpg','4/S__9330779_0.jpg','4/S__9330780_0.jpg','4/S__9330781_0.jpg','4/S__9330782_0.jpg','4/S__9330783_0.jpg','4/S__9330803_0.jpg','4/S__9330804_0.jpg','4/S__9330805_0.jpg','4/S__9330806_0.jpg','4/S__9330833_0.jpg','4/S__9330834_0.jpg','4/S__9330835_0.jpg','4/S__9330836_0.jpg'] },
    { index: 4, title: '皮革局部受傷修復還原', photos: ['5/S__9330786_0.jpg','5/S__9330787_0.jpg','5/S__9330788_0.jpg','5/S__9330789_0.jpg','5/S__9330790_0.jpg'] },
    { index: 5, title: '白色內裝／淺色抗污處理', photos: [] },
    { index: 6, title: '安卓機．行車記錄器安裝', photos: ['7/S__9330795_0.jpg','7/S__9330796_0.jpg','7/S__9330797_0.jpg','7/S__9330798_0.jpg','7/S__9330824_0.jpg','7/S__9330825_0.jpg','7/S__9330826_0.jpg','7/S__9330827_0.jpg','7/S__9330828_0.jpg','7/S__9330829_0.jpg','7/S__9330830_0.jpg'] },
  ];

  const ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName('網站服務照片');
  if (!sheet) {
    sheet = ss.insertSheet('網站服務照片');
    sheet.getRange(1, 1, 1, 3).setValues([['服務編號', '服務名稱', '照片列表(JSON)']]);
    sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
  }

  var totalUploaded = 0;

  for (var si = 0; si < currentServices.length; si++) {
    var svc = currentServices[si];
    var driveUrls = [];

    // 每個服務建子資料夾
    var svcFolder = getOrCreateFolder(photoFolder, svc.index + '_' + svc.title);

    for (var pi = 0; pi < svc.photos.length; pi++) {
      var photoPath = svc.photos[pi];
      var url = 'https://www.yinzemy.com/' + photoPath;
      try {
        var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
        if (response.getResponseCode() !== 200) {
          Logger.log('⚠️ 跳過 ' + photoPath + ' (HTTP ' + response.getResponseCode() + ')');
          continue;
        }
        var blob = response.getBlob().setName(photoPath.replace(/\//g, '_'));
        var file = svcFolder.createFile(blob);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        var driveUrl = 'https://lh3.googleusercontent.com/d/' + file.getId();
        driveUrls.push(driveUrl);
        totalUploaded++;
        Logger.log('✅ [' + totalUploaded + '] ' + photoPath + ' → ' + driveUrl);
      } catch (e) {
        Logger.log('❌ ' + photoPath + ': ' + e.toString());
      }
    }

    svc.photos = driveUrls;
  }

  // 寫入試算表
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).clearContent();
  }
  var rows = currentServices.map(function(s) { return [s.index, s.title, JSON.stringify(s.photos)]; });
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 3).setValues(rows);
  }

  Logger.log('🎉 照片遷移完成！共上傳 ' + totalUploaded + ' 張照片');
  return '照片遷移完成！共上傳 ' + totalUploaded + ' 張照片';
}


// ══════════════════════════════════════════
//  一次性：建立「網站影片」工作表並匯入影片 ID
//  ★ 在 GAS 編輯器裡手動執行一次就好
// ══════════════════════════════════════════

function migrateVideos() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName('網站影片');
  if (!sheet) {
    sheet = ss.insertSheet('網站影片');
    sheet.getRange(1, 1).setValue('影片ID');
    sheet.getRange(1, 1).setFontWeight('bold');
  }

  if (sheet.getLastRow() > 1) {
    Logger.log('⚠️ 影片表已有資料（' + (sheet.getLastRow() - 1) + ' 筆），跳過匯入');
    return '影片表已有資料，未覆蓋';
  }

  var allVideoIds = [
    "FzmEcoa-XYc","kwWg8U0yLos","S8XBl6ujtxM","FY7qe_ql8k0","UdMym_hiHZM","qDRK3DNNTXM","YXYCmw78ITc","3pEsV4j29_E","sWk-OZSZ4ug","i7ZUovo8qIA",
    "ydnvRe2jP3c","KGc5ZgozA5U","y1npaxDGtkg","r4Vx1CKIWeY","rL4_9v96gJ0","MFI-o6DR6UY","ljU67cpeSgw","GKlURjYOvGs","MfR_tEb3VK0","coCYA0YzLn4",
    "3liObdUgmkc","ERSS4olJ_rE","D6OU0Iu9UiA","m6sCACT04R0","rj-Fx943u-g","GTWrBwja12U","2Qs4NVWcIV8","otqNZlCz_io","krNxqIZWzj8","dOgxFz4Is_Q",
    "IHD0KYtlHi4","vd3y_VYfByQ","yYpDvjSMl5M","clTjpIsUnIw","oANI96_He6k","sJYfIFdS0vU","HgLzWOPAwR8","iiszt6ite48","rpSXMyDfHU4","B_dXs1x8E34",
    "RSH1ifWOC8w","FNSUpBFbJRU","KcDW_g0Q050","RxlvQkXGimY","Phw4uYmbEnY","6n_IY9fWxvg","2jvIo_-IMlk","F6lyN44fKPE",
    "w9NpCWRQgAI","PrOZWm0puS0","YS3ZUz2tilI","oj6QI-tOI9E","NoDiyOF-wYE","7DIIn7njz5Y","0mnTfxJYwc8","Js91ORmqjto","NHUM8Onrkl8","DCEHQ7utPNw",
    "B9VSRtUH-_4","M3WMLUieZEE","iPJIaYduslA","mkmVRiiTwk0","mz2d_JhJJlM","TENfRXaWyTM","VAIwl5fjiig","PfFHqsqNJmA","Obnj3UCi9lc","D7vKPjdRNLw",
    "Dmz_kM-ibKM","Uy6fprQJKdY","P7VCmqf47rk","ylS7lHAOkWQ","LlhHqiiPfuU","czqgBCs8qJw","E2VtZz9vXs0","KrfiX5Y5Vo4","bckqUBHaxCI","29IfOB8GUag",
    "uaPmZqUOKZk","7n-g2n0MeQ0","yV2Pbd0oKkc","-xBYlblOo24","0lM5QlwAvJI","A0pELjb7EmM","TF0G34w0MxQ","e9SXyGSsLsY","klf0lrgkrlY","pzuhlEYn5Og",
    "9tYn9MFvBZI","RxSwySvQcXM","_SkvSFpY92k","8G7EphB98kY","nHvYnGHx2KQ","2TBxbIZ-zTM","TTL9ap9pQ2c","muweX6mDkhc","H3_AqvzcIqQ","Jae_4DU2Tqw",
    "twNzIWpqixc","P1Gb7fnf6Qo","5Dngoz-TBhE","4ZrvY89H8dE","cuINoxBihVE","oIm3IM5-TG4","KW8J9WWjVMc","Qg6W64QsAWA","qkytXJfCfqY","iblfLanTUaE",
    "IYM690UlA0Y","Axk49qoHcCE","X0znmeWJtig","vnU9cHX8aos","x8cw9pytkwY","OpsQO7BPucE","wTiKBjDCL48","oAvDf5GcSwQ","cYXIffury3U","M4uWK51ekas",
    "v2rUV0IRh2E","NRBbF0BpzMU","XdXRDSJzosI","7ryIzSO5yos","3bbO_Q-SRIk","eP9E1z8VnLo","hdd4axPBGf0","62QlhiWcJ_w","Mv8qE_X7_zA","jaLDJKqmNN8",
    "-CRytXuFNg4","Vjj59I5Voig","rlSmsZi2HTQ","bximiSe1scU","rC_HwbJhSW8","LMZliV6Mvfg","dtI-mfOGp8o","dZ1pd-awVKQ","6qgxk_Ildu8","XEpCAjyliL0",
    "YBdfu6VJnmc","mEaWwYYqjpA","azLxlRSEEJo","1nb5mLjDoHQ","uYbWl8j33zA","bc9Jq77mEOc","HcSsgjk5zmg","eo0o3YCM2uQ","k2k4XR5u_gg","fk-3IMRi-IE",
    "97Qo0KNQtLw","GXa33Z_yUQw","MT-oNDaMo5A","66VJ6iMqyXU","h93B3mrHtOg","RuZkGblKG0w","QJ7yez2EE_E","jnX0hXzv_7Y","2xcKbSs5rIk","KR4m1ouN1IE",
    "Z5zY-Z_ZfqU","tq1Rc94-7RI","8sx06FO_iKY","gD_JTrpNQ0g","lQTD9No8xsM","XdONVj5fZeg","CHYxRy0RV1I","6HvXSF8nXsM","T6J3qL0l40Y","di8P7L9WCvs",
    "v8R9HPWAut8","d-sx1KQm5SA","-NPV54hGbRM","OkGxY6_r28o","QQtRESCCYyI","x4WkUTxvEDE","Jh6ZbWBGbOo","ydgU6c03tK8","VlaRVFPc1UM","QlWqHngKJQs",
    "wYuWnIuDbeI","PO_Olo5aOvg","x1LDhAFOswk","jGhKUy-APuA","_NuvEBLluTE","OfdoH5euvCY","meShIJCoI3c","zcF_-XJwnwI","N3oJj2EV56k","dlcpftbPFqA",
    "rVd1kmrFShg","Itu85KLtcBY","TuZ3gK5CZYg","iKqh8MFO6x8","hQFJl7NyTuA","6LE_qyf2-DY","u1uyTbFHNu4","h2SwCKv0yx8","NAEKWLRqI7Y","HKK0teel6Lc",
    "1S5PtViDKuo","S17hSS0yLKg","z1ezmO4_NeQ","oK_hoPxYgDQ","0cBzD1ixwBw","w04MFrDIp9M","KcatZzwF5R4","8m6fllPOgAc","PjA1VioblpE","Y838PtolbgM",
    "UrtTX2RuYz8","a9pCVBB3-4E","HI-w7snEvMY","2Q2BUS4hX8Q","CJglX8i8KKg","mD9Gf_tvcYw","kMXHgz6tiaI","m8QZdqEIq-w","936w2XTvf_I","TsPE_G7IzYA",
    "rQ_0WcvBNAA","NUALFxpgejI","eXazelGbPKE","XxTFsDqSujg","OkariTTRiI8","LVf0PLVKn0Y","3c2eD8LfkTg","xO5CjSj4BXA","JHYqWOl-YMs","PmMGkRjE-uM",
    "3Iq1DFCG1t8","Phr0xM8lMlw","JQs5FkZ4Zuw","GVEGq2clLZ4","IWctQQlIPdY","QcReF-GO3fQ","nKj7tJQ4gbc","yxhED67MiWs","-pl4Q_DokEM",
  ];

  var rows = allVideoIds.map(function(id) { return [id]; });
  sheet.getRange(2, 1, rows.length, 1).setValues(rows);
  Logger.log('✅ 影片已匯入 ' + rows.length + ' 筆');
  return '影片匯入完成！共 ' + rows.length + ' 筆';
}


// ══════════════════════════════════════════
//  從 LINE 下載照片 → 存入 Google Drive → 記錄到「照片記錄」表
// ══════════════════════════════════════════
function savePhoto(data) {
  // 加鎖：防止多張照片同時寫入時產生重複記錄
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
  const folder = DriveApp.getFolderById(FOLDER_ID);

  // 用客戶 LINE 暱稱當資料夾名稱
  const customerName = data.customerName || data.userId;
  const customerFolder = getOrCreateFolder(folder, customerName);

  const dateStr = Utilities.formatDate(
    new Date(data.timestamp),
    'Asia/Taipei',
    'yyyy-MM-dd'
  );

  // 從 LINE API 直接下載照片
  const imgRes = UrlFetchApp.fetch(
    'https://api-data.line.me/v2/bot/message/' + data.messageId + '/content',
    {
      headers: { 'Authorization': 'Bearer ' + data.accessToken },
      muteHttpExceptions: true
    }
  );

  if (imgRes.getResponseCode() !== 200) {
    console.error('LINE 照片下載失敗：' + imgRes.getResponseCode());
    return jsonResponse({ status: 'error', message: 'LINE download failed' });
  }

  const blob = imgRes.getBlob().setName(
    dateStr + '_' + data.messageId + '.jpg'
  );
  const file = customerFolder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const fileUrl = file.getUrl();
  const directUrl = 'https://lh3.googleusercontent.com/d/' + file.getId();

  const timeStr = Utilities.formatDate(
    new Date(data.timestamp),
    'Asia/Taipei',
    'yyyy-MM-dd HH:mm:ss'
  );

  // 寫入「客戶照片」試算表
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName('客戶照片');
  if (!sheet) {
    sheet = ss.insertSheet('客戶照片');
    sheet.getRange(1, 1, 1, 8).setValues([['時間', '客戶名稱', '用戶ID', '服務項目', '照片連結', '縮圖連結', '檔案ID', '老闆筆記']]);
    sheet.getRange(1, 1, 1, 8).setFontWeight('bold');
  }

  sheet.appendRow([
    timeStr,
    customerName,
    data.userId,
    data.serviceName || '',
    fileUrl,
    directUrl,
    file.getId(),
    ''  // 老闆筆記（預留空白）
  ]);

  console.log('✅ 照片已儲存：' + file.getName() + ' → ' + customerName + '/');
  return jsonResponse({ status: 'ok', file: file.getName(), url: fileUrl });

  } finally {
    lock.releaseLock();
  }
}

// ══════════════════════════════════════════
//  記錄對話到「對話記錄」表
// ══════════════════════════════════════════
function logConversation(data) {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  let sheet = ss.getSheetByName('對話記錄');
  if (!sheet) {
    sheet = ss.insertSheet('對話記錄');
    sheet.getRange(1, 1, 1, 6).setValues([['時間', '客戶名稱', '用戶ID', '角色', '訊息類型', '內容']]);
    sheet.getRange(1, 1, 1, 6).setFontWeight('bold');
  }

  const timeStr = Utilities.formatDate(
    new Date(data.timestamp),
    'Asia/Taipei',
    'yyyy-MM-dd HH:mm:ss'
  );

  sheet.appendRow([
    timeStr,
    data.customerName || data.userId,
    data.userId,
    data.role,
    data.msgType,
    data.content
  ]);

  return jsonResponse({ status: 'ok' });
}

// ══════════════════════════════════════════
//  記錄車機詢問到「車機詢問」表
// ══════════════════════════════════════════
function logCarMachine(data) {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  let sheet = ss.getSheetByName('車機詢問');
  if (!sheet) {
    sheet = ss.insertSheet('車機詢問');
    sheet.getRange(1, 1, 1, 5).setValues([['時間', '客戶名稱', '用戶ID', '廠牌', '車型']]);
    sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
  }

  const timeStr = Utilities.formatDate(
    new Date(data.timestamp),
    'Asia/Taipei',
    'yyyy-MM-dd HH:mm:ss'
  );

  sheet.appendRow([
    timeStr,
    data.customerName || data.userId,
    data.userId,
    data.brand,
    data.model,
  ]);

  return jsonResponse({ status: 'ok' });
}

// ══════════════════════════════════════════
//  建立 Google Calendar 預約事件
// ══════════════════════════════════════════
function createAppointment(data) {
  try {
    const cal = CalendarApp.getDefaultCalendar();
    const start = new Date(data.startTime);
    const end = new Date(data.endTime);

    const event = cal.createEvent(data.title, start, end, {
      description: data.description || '',
      location: '高雄市鳥松區中正路101號',
    });

    // 記錄到「預約記錄」表
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sheet = ss.getSheetByName('預約記錄');
    if (!sheet) {
      sheet = ss.insertSheet('預約記錄');
      sheet.getRange(1, 1, 1, 5).setValues([['預約時間', '客戶名稱', '用戶ID', '建立時間', '日曆事件ID']]);
      sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    }

    const timeStr = Utilities.formatDate(start, 'Asia/Taipei', 'yyyy-MM-dd HH:mm');
    const nowStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');

    sheet.appendRow([
      timeStr,
      data.customerName || data.customerId,
      data.customerId,
      nowStr,
      event.getId(),
    ]);

    return jsonResponse({ status: 'ok', eventId: event.getId() });
  } catch (err) {
    console.error('建立日曆事件失敗：', err.toString());
    return jsonResponse({ status: 'error', message: err.toString() });
  }
}


// ══════════════════════════════════════════
//  工具函式
// ══════════════════════════════════════════
function getOrCreateFolder(parent, name) {
  const folders = parent.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : parent.createFolder(name);
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function corsJson(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ══════════════════════════════════════════
//  初始化：建立試算表的表頭（只需執行一次）
// ══════════════════════════════════════════
function initSheets() {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  let photoSheet = ss.getSheetByName('照片記錄');
  if (!photoSheet) {
    photoSheet = ss.insertSheet('照片記錄');
  }
  photoSheet.getRange(1, 1, 1, 5).setValues([['時間', '客戶名稱', '用戶ID', '照片連結', '檔案名稱']]);
  photoSheet.getRange(1, 1, 1, 5).setFontWeight('bold');

  let chatSheet = ss.getSheetByName('對話記錄');
  if (!chatSheet) {
    chatSheet = ss.insertSheet('對話記錄');
  }
  chatSheet.getRange(1, 1, 1, 6).setValues([['時間', '客戶名稱', '用戶ID', '角色', '訊息類型', '內容']]);
  chatSheet.getRange(1, 1, 1, 6).setFontWeight('bold');

  let carSheet = ss.getSheetByName('車機詢問');
  if (!carSheet) {
    carSheet = ss.insertSheet('車機詢問');
  }
  carSheet.getRange(1, 1, 1, 5).setValues([['時間', '客戶名稱', '用戶ID', '廠牌', '車型']]);
  carSheet.getRange(1, 1, 1, 5).setFontWeight('bold');

  Logger.log('✅ 工作表初始化完成');
}

function test() {
  const folder = DriveApp.getFolderById(FOLDER_ID);
  Logger.log('資料夾名稱：' + folder.getName());
  const ss = SpreadsheetApp.openById(SHEET_ID);
  Logger.log('試算表名稱：' + ss.getName());
  Logger.log('✅ 連線正常');
}

// 觸發外部連線授權（執行一次即可）
function triggerAuth() {
  UrlFetchApp.fetch('https://www.google.com');
  Logger.log('✅ 外部連線授權成功');
}
