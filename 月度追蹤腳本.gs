/**
 * SEO + AIO 月度自動追蹤腳本
 *
 * 使用方式：
 * 1. 前往 script.google.com → 新增專案
 * 2. 貼上此程式碼
 * 3. 修改下方「設定區」的 ID
 * 4. 執行一次 setup() 設定觸發器
 * 5. 第一次執行需手動按 runMonthlyReport() 並授權
 */

// ─── 設定區（請填入你的資料）─────────────────────────────
const CONFIG = {
  // GA4 數值串流 ID（GA4 → 管理 → 資料串流 → 找「評估 ID」旁邊的「G-XXXXXXXXXX」前面的純數字）
  // 例如：GA4 Property 頁面 URL 是 .../p123456789 → 填 "123456789"
  GA4_PROPERTY_ID: "YOUR_GA4_PROPERTY_ID",

  // shengtingbio.com 在 GSC 登記的網址（通常含 https://）
  GSC_SHENGTINGBIO: "https://shengtingbio.com/",

  // yardley.tw 在 GSC 登記的網址
  GSC_YARDLEY: "https://www.yardley.tw/",

  // Google Sheet 名稱（會自動建立）
  SHEET_NAME: "SEO月度追蹤",

  // 品牌搜尋詞（用 | 分隔）
  BRAND_QUERIES_YARDLEY: "苼莛|yardley|苼莛生技",
  BRAND_QUERIES_SHENGTING: "苼莛生技雜誌|shengtingbio",
};
// ─────────────────────────────────────────────────────────

/**
 * 首次設定：建立每月 1 日執行的觸發器
 * 只需執行一次。
 */
function setup() {
  // 刪除已有同名觸發器避免重複
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === "runMonthlyReport") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("runMonthlyReport")
    .timeBased()
    .onMonthDay(1)
    .atHour(9)
    .create();
  Logger.log("✅ 觸發器設定完成：每月 1 日 09:00 自動執行");
}

/**
 * 主程式：拉取所有指標並寫入 Google Sheet
 */
function runMonthlyReport() {
  const ss = getOrCreateSheet();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);

  // 計算上個月的日期範圍
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth(); // 0-indexed，目前月份
  const startDate = Utilities.formatDate(new Date(y, m - 1, 1), "GMT", "yyyy-MM-dd");
  const endDate = Utilities.formatDate(new Date(y, m, 0), "GMT", "yyyy-MM-dd");
  const monthLabel = `${y}/${m < 10 ? "0" + m : m}`;

  Logger.log(`📅 抓取期間：${startDate} ～ ${endDate}`);

  const row = [monthLabel];

  // ── GA4 指標 ────────────────────────────────────────────
  try {
    const ga4 = fetchGA4(CONFIG.GA4_PROPERTY_ID, startDate, endDate);
    row.push(
      pct(ga4.engagementRate),          // Organic Engagement Rate
      ga4.aiSessions,                    // AI Referral Sessions（見下方）
      sec(ga4.avgEngagementTimeFaq),     // FAQ 文章平均參與時間
      pct(ga4.scrollRate90)              // 90% Scroll Rate
    );
  } catch (e) {
    Logger.log("⚠️ GA4 錯誤：" + e.message);
    row.push("錯誤", "錯誤", "錯誤", "錯誤");
  }

  // ── GSC：shengtingbio.com ────────────────────────────────
  try {
    const gsc = fetchGSC(CONFIG.GSC_SHENGTINGBIO, startDate, endDate);
    row.push(
      gsc.clicks,        // 點擊數
      gsc.impressions,   // 曝光數
      pct(gsc.ctr),      // CTR
      fetchGSCRichResults(CONFIG.GSC_SHENGTINGBIO, startDate, endDate), // Rich Result 曝光頁數
      fetchGSCIndexed(CONFIG.GSC_SHENGTINGBIO)  // 索引覆蓋率
    );
  } catch (e) {
    Logger.log("⚠️ GSC shengtingbio 錯誤：" + e.message);
    row.push("錯誤", "錯誤", "錯誤", "錯誤", "錯誤");
  }

  // ── GSC：yardley.tw 品牌查詢 ────────────────────────────
  try {
    const brandClicks = fetchGSCBrandClicks(CONFIG.GSC_YARDLEY, startDate, endDate, CONFIG.BRAND_QUERIES_YARDLEY);
    const gscY = fetchGSC(CONFIG.GSC_YARDLEY, startDate, endDate);
    row.push(brandClicks, gscY.impressions);
  } catch (e) {
    Logger.log("⚠️ GSC yardley 錯誤：" + e.message);
    row.push("錯誤", "錯誤");
  }

  // ── 手動欄位（留空，由使用者自行填入）───────────────────
  row.push("", "", "", "");  // FAQ 覆蓋篇數、Perplexity、AIO yardley、AIO shengting

  // ── 寫入 Sheet ──────────────────────────────────────────
  appendRow(sheet, row);
  Logger.log("✅ 本月資料已寫入：" + monthLabel);
}

// ═══════════════════════════════════════════════════════════
//  GA4 Data API
// ═══════════════════════════════════════════════════════════
function fetchGA4(propertyId, startDate, endDate) {
  const token = ScriptApp.getOAuthToken();
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`;

  const payload = {
    dateRanges: [{ startDate, endDate }],
    metrics: [
      { name: "engagementRate" },
      { name: "averageSessionDuration" },
      { name: "eventCount" },    // 用於抓 scroll 事件
      { name: "sessions" }
    ],
    dimensionFilter: {
      filter: {
        fieldName: "sessionDefaultChannelGroup",
        stringFilter: { matchType: "CONTAINS", value: "Organic Search" }
      }
    }
  };

  const resp = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const data = JSON.parse(resp.getContentText());
  if (data.error) throw new Error(data.error.message);

  const row = data.rows?.[0]?.metricValues || [];
  const engagementRate = parseFloat(row[0]?.value || 0);
  const avgTime = parseFloat(row[1]?.value || 0);

  // AI Referral Sessions（需自訂管道群組，這裡先用 0 佔位）
  const aiSessions = fetchGA4AISessions(propertyId, startDate, endDate);

  // Scroll 90% rate
  const scrollRate = fetchGA4ScrollRate(propertyId, startDate, endDate);

  return {
    engagementRate,
    avgEngagementTimeFaq: avgTime,
    aiSessions,
    scrollRate90: scrollRate
  };
}

function fetchGA4AISessions(propertyId, startDate, endDate) {
  const token = ScriptApp.getOAuthToken();
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`;

  const payload = {
    dateRanges: [{ startDate, endDate }],
    metrics: [{ name: "sessions" }],
    dimensionFilter: {
      orGroup: {
        expressions: [
          { filter: { fieldName: "sessionSource", stringFilter: { matchType: "CONTAINS", value: "perplexity" } } },
          { filter: { fieldName: "sessionSource", stringFilter: { matchType: "CONTAINS", value: "chatgpt" } } },
          { filter: { fieldName: "sessionSource", stringFilter: { matchType: "CONTAINS", value: "openai" } } },
          { filter: { fieldName: "sessionSource", stringFilter: { matchType: "CONTAINS", value: "you.com" } } }
        ]
      }
    }
  };

  const resp = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const data = JSON.parse(resp.getContentText());
  return parseInt(data.rows?.[0]?.metricValues?.[0]?.value || 0);
}

function fetchGA4ScrollRate(propertyId, startDate, endDate) {
  const token = ScriptApp.getOAuthToken();
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`;

  // 比較 scroll 事件數 vs 全部 session 數
  const payload = {
    dateRanges: [{ startDate, endDate }],
    metrics: [{ name: "eventCount" }, { name: "sessions" }],
    dimensionFilter: {
      filter: { fieldName: "eventName", stringFilter: { matchType: "EXACT", value: "scroll" } }
    }
  };

  const resp = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const data = JSON.parse(resp.getContentText());
  const scrollCount = parseInt(data.rows?.[0]?.metricValues?.[0]?.value || 0);
  const totalSessions = parseInt(data.rows?.[0]?.metricValues?.[1]?.value || 1);
  return totalSessions > 0 ? scrollCount / totalSessions : 0;
}

// ═══════════════════════════════════════════════════════════
//  Search Console API
// ═══════════════════════════════════════════════════════════
function fetchGSC(siteUrl, startDate, endDate) {
  const token = ScriptApp.getOAuthToken();
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;

  const resp = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({ startDate, endDate, rowLimit: 1 }),
    muteHttpExceptions: true
  });

  const data = JSON.parse(resp.getContentText());
  if (data.error) throw new Error(data.error.message);

  const row = data.rows?.[0] || {};
  return {
    clicks: row.clicks || 0,
    impressions: row.impressions || 0,
    ctr: row.ctr || 0,
    position: row.position || 0
  };
}

function fetchGSCRichResults(siteUrl, startDate, endDate) {
  const token = ScriptApp.getOAuthToken();
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;

  const resp = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({
      startDate, endDate,
      dimensions: ["page"],
      searchType: "web",
      dimensionFilterGroups: [{
        filters: [{ dimension: "searchAppearance", operator: "equals", expression: "RICH_RESULTS" }]
      }],
      rowLimit: 1000
    }),
    muteHttpExceptions: true
  });

  const data = JSON.parse(resp.getContentText());
  return (data.rows || []).length;  // 有 Rich Result 的頁面數
}

function fetchGSCIndexed(siteUrl) {
  // GSC 沒有直接的「索引數」API，用 sitemaps API 估算
  const token = ScriptApp.getOAuthToken();
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps`;

  const resp = UrlFetchApp.fetch(url, {
    headers: { Authorization: "Bearer " + token },
    muteHttpExceptions: true
  });

  const data = JSON.parse(resp.getContentText());
  let submitted = 0, indexed = 0;

  (data.sitemap || []).forEach(s => {
    (s.contents || []).forEach(c => {
      submitted += parseInt(c.submitted || 0);
      indexed += parseInt(c.indexed || 0);
    });
  });

  if (submitted === 0) return "N/A";
  return `${indexed}/${submitted} (${Math.round(indexed/submitted*100)}%)`;
}

function fetchGSCBrandClicks(siteUrl, startDate, endDate, brandQueryPattern) {
  const token = ScriptApp.getOAuthToken();
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;

  const brands = brandQueryPattern.split("|");
  let totalClicks = 0;

  brands.forEach(brand => {
    const resp = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + token },
      payload: JSON.stringify({
        startDate, endDate,
        dimensions: ["query"],
        dimensionFilterGroups: [{
          filters: [{ dimension: "query", operator: "contains", expression: brand.trim() }]
        }],
        rowLimit: 500
      }),
      muteHttpExceptions: true
    });

    const data = JSON.parse(resp.getContentText());
    (data.rows || []).forEach(r => { totalClicks += r.clicks || 0; });
  });

  return totalClicks;
}

// ═══════════════════════════════════════════════════════════
//  Google Sheet 工具函式
// ═══════════════════════════════════════════════════════════
function getOrCreateSheet() {
  let ss;
  try {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  } catch (e) {
    // 若從觸發器執行，用 ID 取得（第一次執行後手動填入）
    ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty("SHEET_ID"));
  }

  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    writeHeaders(sheet);
  }
  return ss;
}

function writeHeaders(sheet) {
  const headers = [
    "月份",
    // GA4
    "GA4 Engagement Rate", "AI Referral Sessions", "FAQ 文章參與時間(秒)", "Scroll 90% Rate",
    // GSC shengtingbio
    "GSC 點擊數(SB)", "GSC 曝光數(SB)", "平均 CTR(SB)", "Rich Result 頁數", "索引覆蓋率",
    // GSC yardley
    "品牌查詢點擊數(YD)", "總曝光數(YD)",
    // 手動
    "FAQ Schema 覆蓋篇數", "Perplexity 引用率(X/10)", "AIO 評分 yardley", "AIO 評分 shengtingbio"
  ];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#1b1b2f").setFontColor("#ffffff");
  sheet.setFrozenRows(1);
}

function appendRow(sheet, row) {
  // 找下一個空白列
  const lastRow = sheet.getLastRow();
  sheet.getRange(lastRow + 1, 1, 1, row.length).setValues([row]);

  // 高亮新行
  sheet.getRange(lastRow + 1, 1, 1, row.length).setBackground("#f0fff4");
}

// ═══════════════════════════════════════════════════════════
//  格式化工具
// ═══════════════════════════════════════════════════════════
function pct(val) {
  return Math.round(parseFloat(val || 0) * 100) + "%";
}

function sec(val) {
  return Math.round(parseFloat(val || 0)) + "s";
}
