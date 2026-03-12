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

  const existingRecords = await getAllRecords(appToken, tableId);
  const existingMap = {};
  for (const r of existingRecords) {
    const noteId = r.fields['笔记ID'];
    if (noteId) existingMap[noteId] = r.record_id;
  }

  const toCreate = [];
  const toUpdate = [];

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
      '数据更新时间': Date.now(),
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

    if (existingMap[noteId]) {
      toUpdate.push({ record_id: existingMap[noteId], fields });
    } else {
      toCreate.push({ fields });
    }
  }

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
      retries++;
      if (retries >= 3) break;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return records;
}
