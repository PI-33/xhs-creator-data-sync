importScripts('lib/feishu-api.js');

// ===== Side Panel =====

chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (chrome.sidePanel.open) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch (e) {
    console.warn('[XHS-Sync] Failed to open side panel:', e);
  }
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ===== Message Handler =====

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'WRITE_TO_FEISHU') {
    handleWriteToFeishu(message.config, message.data)
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'TEST_FEISHU') {
    testFeishuConnection(message.config)
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'CREATE_TABLES') {
    handleCreateTables(message.config)
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'SET_AUTO_SYNC') {
    setupAutoSync(message.hour, message.minute)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'CANCEL_AUTO_SYNC') {
    cancelAutoSync()
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'GET_SYNC_STATUS') {
    chrome.storage.local.get(['lastAutoSync'])
      .then(data => sendResponse({ success: true, data: data.lastAutoSync || null }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'TRIGGER_AUTO_SYNC') {
    autoSync()
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// ================================================================
// 两张表的字段定义 — 与飞书多维表格字段类型对齐
//   type 1=文本, 2=数字, 3=单选, 5=日期, 15=链接
// ================================================================

const TABLE_SCHEMAS = {
  noteTable: {
    defaultName: '笔记数据',
    fields: [
      { field_name: '账号名称',   type: 1 },
      { field_name: '笔记ID',     type: 1 },
      { field_name: '标题',       type: 1 },
      { field_name: '封面图',     type: 15 },
      { field_name: '发布时间',   type: 5 },
      { field_name: '笔记类型',   type: 3, property: { options: [{ name: '图文' }, { name: '视频' }] } },
      { field_name: '审核状态',   type: 3, property: { options: [{ name: '已通过' }, { name: '审核中' }, { name: '未通过' }] } },
      { field_name: '曝光数',     type: 2 },
      { field_name: '观看数',     type: 2 },
      { field_name: '封面点击率', type: 2 },
      { field_name: '点赞数',     type: 2 },
      { field_name: '评论数',     type: 2 },
      { field_name: '收藏数',     type: 2 },
      { field_name: '分享数',     type: 2 },
      { field_name: '涨粉数',     type: 2 },
      { field_name: '数据更新时间', type: 5 },
    ],
  },
  accountTable: {
    defaultName: '账号数据',
    fields: [
      { field_name: '账号名称',   type: 1 },
      { field_name: '日期',       type: 5 },
      { field_name: '总曝光',     type: 2 },
      { field_name: '总观看',     type: 2 },
      { field_name: '封面点击率', type: 2 },
      { field_name: '平均观看时长', type: 2 },
      { field_name: '观看总时长', type: 2 },
      { field_name: '视频完播率', type: 2 },
      { field_name: '点赞数',     type: 2 },
      { field_name: '评论数',     type: 2 },
      { field_name: '收藏数',     type: 2 },
      { field_name: '分享数',     type: 2 },
      { field_name: '弹幕数',     type: 2 },
      { field_name: '净涨粉',     type: 2 },
      { field_name: '新增关注',   type: 2 },
      { field_name: '取消关注',   type: 2 },
      { field_name: '主页访客',   type: 2 },
      { field_name: '总粉丝数',   type: 2 },
      { field_name: '新增粉丝',   type: 2 },
      { field_name: '流失粉丝',   type: 2 },
      { field_name: '数据更新时间', type: 5 },
    ],
  },
};

// ================================================================
// 自动建表
// ================================================================

async function handleCreateTables(config) {
  FeishuApi.configure(config.appId, config.appSecret);
  await FeishuApi.getToken();

  const appToken = parseBitableUrl(config.bitableUrl);
  if (!appToken) throw new Error('无法解析多维表格链接');

  const tablesResp = await FeishuApi.listTables(appToken);
  const existingNames = (tablesResp.items || []).map(t => t.name);

  const created = [];
  const skipped = [];

  const tableEntries = [
    { key: 'noteTable',    name: config.noteTableName    || TABLE_SCHEMAS.noteTable.defaultName },
    { key: 'accountTable', name: config.accountTableName || TABLE_SCHEMAS.accountTable.defaultName },
  ];

  for (const entry of tableEntries) {
    if (existingNames.includes(entry.name)) {
      skipped.push(entry.name);
      continue;
    }
    const schema = TABLE_SCHEMAS[entry.key];
    await FeishuApi.createTable(appToken, entry.name, schema.fields);
    created.push(entry.name);
  }

  return { created, skipped };
}

// ================================================================
// 写入数据
// ================================================================

async function handleWriteToFeishu(config, rawData) {
  FeishuApi.configure(config.appId, config.appSecret);

  try {
    await FeishuApi.getToken();
  } catch (e) {
    throw new Error(`飞书认证失败，请检查 App ID 和 App Secret: ${e.message}`);
  }

  const appToken = parseBitableUrl(config.bitableUrl);
  if (!appToken) throw new Error('无法解析多维表格链接');

  const data = {};
  for (const [key, val] of Object.entries(rawData)) {
    if (val && typeof val === 'object') {
      data[key] = val;
    }
  }

  return writeDataToFeishu(appToken, data, config);
}

async function testFeishuConnection(config) {
  FeishuApi.configure(config.appId, config.appSecret);
  await FeishuApi.getToken();
  const appToken = parseBitableUrl(config.bitableUrl);
  if (!appToken) throw new Error('无法解析多维表格链接');
  const tablesResp = await FeishuApi.listTables(appToken);
  const tables = (tablesResp.items || []).map(t => t.name);
  return { appToken, tables };
}

function parseBitableUrl(url) {
  if (!url) return null;
  const patterns = [
    /\/base\/([A-Za-z0-9]+)/,
    /app_token=([A-Za-z0-9]+)/,
    /^([A-Za-z0-9]{10,})$/
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// ================================================================
// 按表写入
// ================================================================

async function writeDataToFeishu(appToken, data, config) {
  const result = { written: 0, updated: 0, errors: [], details: {}, debug: {} };

  console.log('[XHS-Sync] writeDataToFeishu called, data keys:', Object.keys(data));
  const debugScopes = {};
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      console.log(`[XHS-Sync]   data.${k} keys:`, keys);
      debugScopes[k] = keys;
    }
  }
  result.debug.receivedScopes = debugScopes;

  let tablesResp;
  try {
    tablesResp = await FeishuApi.listTables(appToken);
  } catch (e) {
    throw new Error(`无法访问多维表格，请确认链接正确且飞书应用有权限: ${e.message}`);
  }

  const tables = tablesResp.items || [];
  const tableMap = {};
  for (const t of tables) tableMap[t.name] = t.table_id;
  console.log('[XHS-Sync] tableMap:', JSON.stringify(tableMap));

  const noteTableName    = config.noteTableName    || '笔记数据';
  const accountTableName = config.accountTableName || '账号数据';
  const accountName      = config.accountName      || '';

  // ---- 笔记数据 ----
  const noteApiData = findApiData(data.notes, ['note/analyze']);
  console.log('[XHS-Sync] noteApiData found:', !!noteApiData, noteApiData ? Object.keys(noteApiData) : 'null');
  if (noteApiData) {
    const tableId = tableMap[noteTableName];
    if (tableId) {
      try {
        const r = await writeNoteData(appToken, tableId, noteApiData, accountName);
        result.written += r.written;
        result.updated += r.updated;
        result.details.notes = r;
      } catch (e) {
        result.errors.push(`笔记数据写入失败: ${e.message}`);
      }
    } else {
      result.errors.push(`未找到名为 "${noteTableName}" 的表，请先创建`);
    }
  }

  // ---- 账号数据（含粉丝数据）----
  const accountApiData = findApiData(data.account, ['account/base']);
  const fansApiData = findApiData(data.fans, ['fans/overall']);
  console.log('[XHS-Sync] accountApiData found:', !!accountApiData, 'fansApiData found:', !!fansApiData);
  if (accountApiData || fansApiData) {
    const tableId = tableMap[accountTableName];
    if (tableId) {
      try {
        const r = await writeAccountData(appToken, tableId, accountApiData, fansApiData, accountName);
        result.written += r.written;
        result.updated += r.updated;
        result.details.account = r;
      } catch (e) {
        result.errors.push(`账号数据写入失败: ${e.message}`);
      }
    } else {
      result.errors.push(`未找到名为 "${accountTableName}" 的表，请先创建`);
    }
  }

  return result;
}

// 在 bridge 缓存的所有 API 响应中，找到目标数据
// bridge 存储的 key 是 pathname，但页面也可能通过 faas/proto 通道获取数据
// 所以需要：1. 先按关键字精确匹配 2. 兜底遍历所有响应的数据结构特征
function findApiData(scopeData, keywords) {
  if (!scopeData || typeof scopeData !== 'object') return null;

  // 优先：按 API path 关键字匹配
  for (const [path, resp] of Object.entries(scopeData)) {
    for (const kw of keywords) {
      if (path.includes(kw)) {
        return resp?.data || resp;
      }
    }
  }

  // 兜底：遍历所有缓存的响应，按数据结构特征识别
  for (const [path, resp] of Object.entries(scopeData)) {
    const d = resp?.data || resp;
    if (!d || typeof d !== 'object') continue;

    // 笔记分析数据特征：有 note_infos 数组
    if (keywords.includes('note/analyze') && d.note_infos) return d;

    // 账号概览数据特征：有 seven.impl_count
    if (keywords.includes('account/base') && d.seven?.impl_count !== undefined) return d;

    // 粉丝数据特征：有 seven.fans_count
    if (keywords.includes('fans/overall') && d.seven?.fans_count !== undefined) return d;
  }

  return null;
}

// ================================================================
// 表1: 笔记数据  ←  note-analyze-response.json
//
// API 字段 → 飞书字段 映射：
//   id               → 笔记ID
//   title            → 标题
//   cover_url        → 封面图
//   post_time        → 发布时间       (ms timestamp)
//   type             → 笔记类型       (1=图文 → "图文")
//   audit_status     → 审核状态       (1=已通过)
//   imp_count        → 曝光数
//   read_count       → 观看数
//   coverClickRate   → 封面点击率     (0.175 → 17.5%)
//   like_count       → 点赞数
//   comment_count    → 评论数
//   fav_count        → 收藏数
//   share_count      → 分享数
//   increase_fans_count → 涨粉数
//   update_time      → 数据更新时间
// ================================================================

const NOTE_TYPE_MAP = { 1: '图文', 2: '视频' };
const AUDIT_STATUS_MAP = { 1: '已通过', 2: '审核中', 3: '未通过' };

async function writeNoteData(appToken, tableId, apiData, accountName) {
  const result = { written: 0, updated: 0 };

  const noteInfos = apiData.note_infos || apiData;
  if (!Array.isArray(noteInfos) || noteInfos.length === 0) return result;

  // 按"笔记ID + 数据更新时间(年月日)"去重：同笔记同天覆盖，不同天新增（保留每日快照）
  const existingRecords = await getAllRecords(appToken, tableId);
  const existingMap = {};
  for (const r of existingRecords) {
    const noteId = r.fields['笔记ID'];
    const updateTs = r.fields['数据更新时间'];
    const ts = typeof updateTs === 'number' ? updateTs : 0;
    if (noteId && ts) {
      existingMap[noteId + '_' + toDayStr(ts)] = r.record_id;
    }
  }

  const toCreate = [];
  const toUpdate = [];
  const now = Date.now();
  const todayStr = toDayStr(now);
  console.log('[XHS-Sync] writeNoteData: existing', existingRecords.length, 'records, dedup keys:', Object.keys(existingMap).length, ', today:', todayStr);

  for (const note of noteInfos) {
    const noteId = note.id;
    if (!noteId) continue;

    const fields = {
      '笔记ID': String(noteId),
      '标题': String(note.title || ''),
      '账号名称': accountName || '',
      '曝光数': Number(note.imp_count || 0),
      '观看数': Number(note.read_count || 0),
      '点赞数': Number(note.like_count || 0),
      '评论数': Number(note.comment_count || 0),
      '收藏数': Number(note.fav_count || 0),
      '分享数': Number(note.share_count || 0),
      '涨粉数': Number(note.increase_fans_count || 0),
      '数据更新时间': now,
    };

    if (note.coverClickRate != null) {
      fields['封面点击率'] = Number((note.coverClickRate * 100).toFixed(1)); // 0.175 → 17.5
    }

    if (note.cover_url) {
      fields['封面图'] = { link: note.cover_url, text: note.title || '封面' };
    }

    if (note.post_time) {
      fields['发布时间'] = note.post_time;
    }

    if (note.type && NOTE_TYPE_MAP[note.type]) {
      fields['笔记类型'] = NOTE_TYPE_MAP[note.type];
    }

    if (note.audit_status && AUDIT_STATUS_MAP[note.audit_status]) {
      fields['审核状态'] = AUDIT_STATUS_MAP[note.audit_status];
    }

    const deduKey = String(noteId) + '_' + todayStr;
    if (existingMap[deduKey]) {
      toUpdate.push({ record_id: existingMap[deduKey], fields });
    } else {
      toCreate.push({ fields });
    }
  }

  console.log('[XHS-Sync] writeNoteData: toCreate', toCreate.length, ', toUpdate', toUpdate.length);

  for (let i = 0; i < toCreate.length; i += 100) {
    const batch = toCreate.slice(i, i + 100);
    await FeishuApi.batchCreateRecords(appToken, tableId, batch);
    result.written += batch.length;
  }
  for (let i = 0; i < toUpdate.length; i += 100) {
    const batch = toUpdate.slice(i, i + 100);
    await FeishuApi.batchUpdateRecords(appToken, tableId, batch);
    result.updated += batch.length;
  }

  return result;
}

// ================================================================
// 表2: 账号数据（含粉丝）
//
// 账号概览 API (data.seven):
//   impl_count           → 总曝光
//   view_count           → 总观看
//   cover_click_rate     → 封面点击率    (6.5 即 6.5%)
//   avg_view_time        → 平均观看时长  (秒)
//   view_time_avg        → 观看总时长    (秒)
//   video_full_view_rate → 视频完播率    (%)
//   like_count           → 点赞数
//   comment_count        → 评论数
//   collect_count        → 收藏数
//   share_count          → 分享数
//   danmaku_count        → 弹幕数
//   net_rise_fans_count  → 净涨粉
//   rise_fans_count      → 新增关注
//   loss_fans_count      → 取消关注
//   home_view_count      → 主页访客
//   end_time             → 日期
//
// 粉丝数据 API (data.seven):
//   fans_count           → 总粉丝数
//   rise_fans_count      → 新增粉丝
//   leave_fans_count     → 流失粉丝
// ================================================================

async function writeAccountData(appToken, tableId, accountData, fansData, accountName) {
  const result = { written: 0, updated: 0 };

  const acct = accountData?.seven;
  const fans = fansData?.seven;
  if (!acct && !fans) return result;

  const dateTs = acct?.end_time || todayTs();

  const fields = { '账号名称': accountName || '', '日期': dateTs, '数据更新时间': Date.now() };

  if (acct) {
    fields['总曝光']       = Number(acct.impl_count || 0);
    fields['总观看']       = Number(acct.view_count || 0);
    fields['封面点击率']   = Number(acct.cover_click_rate || 0);
    fields['平均观看时长'] = Number(acct.avg_view_time || 0);
    fields['观看总时长']   = Number(acct.view_time_avg || 0);
    fields['视频完播率']   = Number(acct.video_full_view_rate || 0);
    fields['点赞数']       = Number(acct.like_count || 0);
    fields['评论数']       = Number(acct.comment_count || 0);
    fields['收藏数']       = Number(acct.collect_count || 0);
    fields['分享数']       = Number(acct.share_count || 0);
    fields['弹幕数']       = Number(acct.danmaku_count || 0);
    fields['净涨粉']       = Number(acct.net_rise_fans_count || 0);
    fields['新增关注']     = Number(acct.rise_fans_count || 0);
    fields['取消关注']     = Number(acct.loss_fans_count || 0);
    fields['主页访客']     = Number(acct.home_view_count || 0);
  }

  if (fans) {
    fields['总粉丝数'] = Number(fans.fans_count || 0);
    fields['新增粉丝'] = Number(fans.rise_fans_count || 0);
    fields['流失粉丝'] = Number(fans.leave_fans_count || 0);
  }

  return upsertByDate(appToken, tableId, dateTs, fields, result);
}

// ================================================================
// Helpers
// ================================================================

function todayTs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 时间戳 → "YYYY-MM-DD"，用于按天去重
function toDayStr(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// 按"账号名称 + 日期"去重：同账号同一天只保留一行
async function upsertByDate(appToken, tableId, dateTs, fields, result) {
  const existingRecords = await getAllRecords(appToken, tableId);
  let existingRecordId = null;

  const dayStart = new Date(dateTs);
  dayStart.setHours(0, 0, 0, 0);
  const dayStartTs = dayStart.getTime();
  const dayEndTs = dayStartTs + 86400000;
  const targetName = fields['账号名称'] || '';

  for (const r of existingRecords) {
    const d = r.fields['日期'];
    const ts = typeof d === 'number' ? d : (typeof d === 'object' ? d?.value : null);
    const recName = r.fields['账号名称'] || '';
    if (ts && ts >= dayStartTs && ts < dayEndTs && recName === targetName) {
      existingRecordId = r.record_id;
      break;
    }
  }

  console.log('[XHS-Sync] upsertByDate: existing records', existingRecords.length, ', matched recordId:', existingRecordId, ', date range:', dayStartTs, '-', dayEndTs, ', account:', targetName);

  if (existingRecordId) {
    await FeishuApi.updateRecord(appToken, tableId, existingRecordId, fields);
    result.updated = 1;
  } else {
    await FeishuApi.batchCreateRecords(appToken, tableId, [{ fields }]);
    result.written = 1;
  }
  return result;
}

async function getAllRecords(appToken, tableId) {
  const records = [];
  let pageToken = null;
  let retries = 0;
  while (retries < 3) {
    try {
      const resp = await FeishuApi.listRecords(appToken, tableId, 100, pageToken);
      if (resp.items) records.push(...resp.items);
      if (!resp.has_more) break;
      pageToken = resp.page_token;
      retries = 0;
    } catch (e) {
      console.error('[XHS-Sync] getAllRecords failed:', e.message, '(retry', retries + 1, '/ 3)');
      retries++;
      if (retries >= 3) {
        console.error('[XHS-Sync] getAllRecords gave up after 3 retries, returning', records.length, 'records so far');
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  console.log('[XHS-Sync] getAllRecords returned', records.length, 'records for table', tableId);
  return records;
}

// ================================================================
// 定时自动同步
// ================================================================

const AUTO_SYNC_ALARM = 'xhs-auto-sync';

const AUTO_SCOPES = {
  account: {
    page: 'https://creator.xiaohongshu.com/statistics/account/v2',
    triggerScope: 'account',
  },
  notes: {
    page: 'https://creator.xiaohongshu.com/statistics/data-analysis',
    triggerScope: 'notes',
  },
  fans: {
    page: 'https://creator.xiaohongshu.com/statistics/fans-data',
    triggerScope: 'fans',
  },
};

// ---- Alarm 管理 ----

async function setupAutoSync(hour, minute) {
  await chrome.storage.local.set({ autoSyncEnabled: true, autoSyncHour: hour, autoSyncMinute: minute });

  const now = new Date();
  let target = new Date();
  target.setHours(hour, minute, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);

  const delayMs = target.getTime() - now.getTime();
  await chrome.alarms.create(AUTO_SYNC_ALARM, {
    delayInMinutes: delayMs / 60000,
    periodInMinutes: 24 * 60,
  });
  console.log('[XHS-Sync] Auto-sync alarm set for', target.toLocaleString(), '(every 24h)');
}

async function cancelAutoSync() {
  await chrome.alarms.clear(AUTO_SYNC_ALARM);
  await chrome.storage.local.set({ autoSyncEnabled: false });
  console.log('[XHS-Sync] Auto-sync alarm cancelled');
}

// 扩展安装/更新时恢复 alarm
chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(['autoSyncEnabled', 'autoSyncHour', 'autoSyncMinute']);
  if (data.autoSyncEnabled && data.autoSyncHour != null) {
    await setupAutoSync(data.autoSyncHour, data.autoSyncMinute);
  }
});

// Alarm 触发
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === AUTO_SYNC_ALARM) {
    console.log('[XHS-Sync] Auto-sync alarm fired at', new Date().toLocaleString());
    await autoSync();
  }
});

// ---- 编排函数 ----

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function findOrCreateXhsTab() {
  const tabs = await chrome.tabs.query({ url: 'https://creator.xiaohongshu.com/*' });
  if (tabs.length > 0) return tabs[0];

  console.log('[XHS-Sync] No XHS tab found, creating one...');
  const tab = await chrome.tabs.create({ url: 'https://creator.xiaohongshu.com/statistics/account/v2', active: false });
  await waitForTabComplete(tab.id, 30000);
  return tab;
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function waitForContentScript(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      if (resp?.success) return true;
    } catch (e) {}
    await sleep(500);
  }
  return false;
}

async function autoFetchOneScope(scopeKey, tab) {
  const scope = AUTO_SCOPES[scopeKey];
  if (!scope) return {};

  console.log('[XHS-Sync] Auto-fetch:', scopeKey);

  // 导航到目标页面
  const currentPath = new URL(tab.url).pathname;
  const targetPath = new URL(scope.page).pathname;

  if (currentPath !== targetPath) {
    await chrome.tabs.update(tab.id, { url: scope.page });
  } else {
    await chrome.tabs.reload(tab.id);
  }

  await waitForTabComplete(tab.id, 20000);

  // 等待 content script 加载
  const csReady = await waitForContentScript(tab.id, 15000);
  if (!csReady) {
    console.warn('[XHS-Sync] Auto-fetch: content script not ready for', scopeKey);
    return {};
  }

  // 触发 JSON API
  await sleep(3000);
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_JSON_API', scope: scope.triggerScope });
  } catch (e) {
    console.warn('[XHS-Sync] Auto-fetch: trigger failed for', scopeKey, e.message);
  }
  await sleep(3000);

  // 笔记翻页
  if (scopeKey === 'notes') {
    try {
      const pageResp = await chrome.tabs.sendMessage(tab.id, { type: 'PAGINATE_NOTES' });
      if (pageResp?.pagesLoaded > 0) {
        console.log('[XHS-Sync] Auto-fetch: paginated', pageResp.pagesLoaded, 'pages');
      }
    } catch (e) {
      console.warn('[XHS-Sync] Auto-fetch: paginate failed', e.message);
    }
    await sleep(2000);
  }

  // 收集缓存数据
  let cachedData = {};
  for (let attempt = 1; attempt <= 10; attempt++) {
    await sleep(attempt <= 3 ? 2000 : 3000);
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_ALL_CACHED' });
      if (resp?.success && resp.data && Object.keys(resp.data).length > 0) {
        cachedData = resp.data;
        break;
      }
    } catch (e) {}
  }

  const count = Object.keys(cachedData).length;
  console.log('[XHS-Sync] Auto-fetch:', scopeKey, '- intercepted', count, 'APIs');
  return cachedData;
}

// ---- 自动同步主函数 ----

async function autoSync() {
  console.log('[XHS-Sync] === Auto-sync started ===');
  const syncResult = { time: Date.now(), success: false, written: 0, updated: 0, errors: [] };

  try {
    // 读取飞书配置
    const config = await chrome.storage.local.get([
      'appId', 'appSecret', 'bitableUrl', 'noteTableName', 'accountTableName', 'accountName'
    ]);

    if (!config.appId || !config.appSecret || !config.bitableUrl) {
      throw new Error('飞书配置不完整，请在侧边栏设置 App ID、App Secret 和多维表格链接');
    }

    const feishuConfig = {
      appId: config.appId,
      appSecret: config.appSecret,
      bitableUrl: config.bitableUrl,
      noteTableName: config.noteTableName || '笔记数据',
      accountTableName: config.accountTableName || '账号数据',
      accountName: config.accountName || '',
    };

    // 找到或创建 XHS tab
    const tab = await findOrCreateXhsTab();
    // 刷新 tab 信息（create 后 url 可能还没更新）
    const freshTab = await chrome.tabs.get(tab.id);

    // 依次抓取三类数据
    const result = {};
    for (const sk of ['account', 'notes', 'fans']) {
      result[sk] = await autoFetchOneScope(sk, freshTab);
    }

    // 自动提取账号名称
    if (!feishuConfig.accountName) {
      for (const scopeData of Object.values(result)) {
        if (!scopeData || typeof scopeData !== 'object') continue;
        for (const resp of Object.values(scopeData)) {
          const d = resp?.data || resp;
          if (d?.userName) {
            feishuConfig.accountName = d.userName;
            await chrome.storage.local.set({ accountName: d.userName });
            break;
          }
        }
        if (feishuConfig.accountName) break;
      }
    }

    // 写入飞书
    const writeResult = await handleWriteToFeishu(feishuConfig, result);
    syncResult.success = true;
    syncResult.written = writeResult.written;
    syncResult.updated = writeResult.updated;
    syncResult.errors = writeResult.errors || [];

    console.log('[XHS-Sync] === Auto-sync completed: written', writeResult.written, 'updated', writeResult.updated, '===');
  } catch (err) {
    syncResult.errors.push(err.message);
    console.error('[XHS-Sync] === Auto-sync failed:', err.message, '===');
  }

  await chrome.storage.local.set({ lastAutoSync: syncResult });
  return syncResult;
}
