/**
 * Google Apps Script - LINE 照片存檔 + 記錄表
 *
 * 功能：
 *   1. 由 GAS 直接從 LINE 下載照片存入 Google Drive（Worker 只傳 messageId）
 *   2. 照片記錄表：同天同客戶合併一筆，照片連結換行分隔
 *   3. 對話記錄表：所有訊息往來紀錄
 *
 * 使用方式：
 *   1. 前往 https://script.google.com 建立新專案
 *   2. 將此程式碼貼上
 *   3. 修改下方 FOLDER_ID 和 SHEET_ID
 *   4. 部署為「網路應用程式」，執行身分「我」，存取權「所有人」
 *   5. 複製部署網址，貼到 Cloudflare Worker 的 GAS_URL 環境變數
 */

// ★ 修改這裡：換成你的 Google Drive 資料夾 ID
const FOLDER_ID = '1h1zv-DhIWaLbAJydxITEmIPAuCrww0M3';

// ★ 修改這裡：換成你的 Google Sheets ID
const SHEET_ID = '1lgQh3gh3T9G52rosEuG48tkfRLCRGQ7V-j-M0xUtHuA';

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    // 根據 action 分流處理
    if (data.action === 'log_conversation') {
      return logConversation(data);
    } else if (data.action === 'save_photo') {
      return savePhoto(data);
    } else if (data.action === 'log_car_machine') {
      return logCarMachine(data);
    }

    return jsonResponse({ status: 'error', message: 'unknown action' });

  } catch (err) {
    console.error('❌ 錯誤：', err.toString());
    return jsonResponse({ status: 'error', message: err.toString() });
  }
}

// ══════════════════════════════════════════
//  從 LINE 下載照片 → 存入 Google Drive → 記錄到「照片記錄」表
// ══════════════════════════════════════════
function savePhoto(data) {
  // 加鎖：防止多張照片同時寫入時產生重複記錄
  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // 等待最多 30 秒

  try {
  const folder = DriveApp.getFolderById(FOLDER_ID);

  // 建立日期子資料夾
  const dateStr = Utilities.formatDate(
    new Date(data.timestamp),
    'Asia/Taipei',
    'yyyy-MM-dd'
  );
  const subFolder = getOrCreateFolder(folder, dateStr);

  // 從 LINE API 直接下載照片（由 GAS 處理，不經過 Worker）
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
    dateStr + '_' + data.userId + '_' + data.messageId + '.jpg'
  );
  const file = subFolder.createFile(blob);

  // 設定檔案為「知道連結的人都能檢視」
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const fileUrl = file.getUrl();

  // 寫入「照片記錄」試算表（同天同客戶合併一筆）
  const dateOnly = dateStr;
  const timeStr = Utilities.formatDate(
    new Date(data.timestamp),
    'Asia/Taipei',
    'yyyy-MM-dd HH:mm:ss'
  );

  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('照片記錄');
  if (sheet) {
    const lastRow = sheet.getLastRow();
    let existingRow = -1;

    if (lastRow > 1) {
      const data2d = sheet.getRange(2, 1, lastRow - 1, 3).getValues();

      for (let i = data2d.length - 1; i >= 0; i--) {
        let rowDate = '';
        const cellVal = data2d[i][0];
        if (cellVal instanceof Date) {
          rowDate = Utilities.formatDate(cellVal, 'Asia/Taipei', 'yyyy-MM-dd');
        } else {
          rowDate = String(cellVal).substring(0, 10);
        }
        const rowUserId = String(data2d[i][2]);

        if (rowDate === dateOnly && rowUserId === data.userId) {
          existingRow = i + 2;
          break;
        }
      }
    }

    if (existingRow > 0) {
      // 合併到既有記錄
      const existingLinks = sheet.getRange(existingRow, 4).getValue();
      const existingFiles = sheet.getRange(existingRow, 5).getValue();
      sheet.getRange(existingRow, 4).setValue(existingLinks + '\n' + fileUrl);
      sheet.getRange(existingRow, 5).setValue(existingFiles + '\n' + file.getName());
      sheet.getRange(existingRow, 1).setValue(timeStr);
    } else {
      // 新增一筆
      sheet.appendRow([
        timeStr,
        data.customerName || data.userId,
        data.userId,
        fileUrl,
        file.getName()
      ]);
    }
  }

  console.log('✅ 照片已儲存：' + file.getName());
  return jsonResponse({ status: 'ok', file: file.getName(), url: fileUrl });

  } finally {
    lock.releaseLock(); // 釋放鎖
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
