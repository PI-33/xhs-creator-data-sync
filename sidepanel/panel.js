document.addEventListener('DOMContentLoaded', async () => {
  const fetchBtn = document.getElementById('fetchBtn');
  const syncBtn = document.getElementById('syncBtn');
  const saveBtn = document.getElementById('saveBtn');
  const progressCard = document.getElementById('progressCard');
  const progressList = document.getElementById('progressList');
  const previewCard = document.getElementById('previewCard');
  const previewTabs = document.getElementById('previewTabs');
  const previewContent = document.getElementById('previewContent');
  const feishuCard = document.getElementById('feishuCard');

  let lastFetchedData = null;

  const SCOPES = {
    account: {
      label: '账号概览',
      page: 'https://creator.xiaohongshu.com/statistics/account/v2',
      trigger: { action: 'TRIGGER_JSON_API', scope: 'account' },
    },
    notes: {
      label: '内容分析',
      page: 'https://creator.xiaohongshu.com/statistics/data-analysis',
      trigger: { action: 'TRIGGER_JSON_API', scope: 'notes' },
    },
    fans: {
      label: '粉丝数据',
      page: 'https://creator.xiaohongshu.com/statistics/fans-data',
      trigger: { action: 'TRIGGER_JSON_API', scope: 'fans' },
    },
  };

  // Load saved config
  const saved = await chrome.storage.local.get([
    'appId', 'appSecret', 'bitableUrl',
    'noteTableName', 'accountTableName', 'accountName'
  ]);
  if (saved.appId) document.getElementById('appId').value = saved.appId;
  if (saved.appSecret) document.getElementById('appSecret').value = saved.appSecret;
  if (saved.bitableUrl) document.getElementById('bitableUrl').value = saved.bitableUrl;
  if (saved.noteTableName) document.getElementById('noteTableName').value = saved.noteTableName;
  if (saved.accountTableName) document.getElementById('accountTableName').value = saved.accountTableName;
  if (saved.accountName) document.getElementById('accountName').value = saved.accountName;

  // ===== Fetch Data =====
  fetchBtn.addEventListener('click', async () => {
    const scope = document.querySelector('input[name="scope"]:checked').value;
    fetchBtn.disabled = true;
    fetchBtn.textContent = '获取中...';
    previewCard.style.display = 'none';
    feishuCard.style.display = 'none';
    lastFetchedData = null;

    // Determine which scopes to run
    const scopeKeys = scope === 'all'
      ? ['account', 'notes', 'fans']
      : [scope];

    initProgress(scopeKeys);

    try {
      const result = {};
      for (const sk of scopeKeys) {
        result[sk] = await fetchOneScope(sk);
      }
      lastFetchedData = result;

      // 自动提取账号名称：从 bridge 拦截的 info API 中获取 userName
      const nameInput = document.getElementById('accountName');
      if (!nameInput.value.trim()) {
        const extracted = extractUserName(result);
        if (extracted) nameInput.value = extracted;
      }

      const hasData = Object.values(result).some(v => v && Object.keys(v).length > 0);
      if (hasData) {
        showPreview(result);
        feishuCard.style.display = 'block';
      } else {
        showError('未获取到任何数据。请检查控制台 [XHS-Bridge] 日志。');
      }
    } catch (err) {
      showError(err.message);
    } finally {
      fetchBtn.disabled = false;
      fetchBtn.textContent = '获取数据';
    }
  });

  async function fetchOneScope(scopeKey) {
    const scope = SCOPES[scopeKey];
    if (!scope) return {};

    updateProgress(scopeKey, 'running', '准备中...');

    // Find XHS tab
    const tab = await findXhsTab();
    if (!tab) {
      updateProgress(scopeKey, 'fail', '未找到小红书页面');
      return {};
    }

    // Navigate or reload
    const currentPath = new URL(tab.url).pathname;
    const targetPath = new URL(scope.page).pathname;

    if (currentPath !== targetPath) {
      updateProgress(scopeKey, 'running', '正在导航...');
      await chrome.tabs.update(tab.id, { url: scope.page });
    } else {
      updateProgress(scopeKey, 'running', '正在刷新...');
      await chrome.tabs.reload(tab.id);
    }

    // Wait for page load
    await waitForTabComplete(tab.id, 20000);
    updateProgress(scopeKey, 'running', '等待页面加载...');

    // Wait for content script
    const csReady = await waitForContentScript(tab.id, 15000);
    if (!csReady) {
      updateProgress(scopeKey, 'fail', '内容脚本未加载');
      return {};
    }

    updateProgress(scopeKey, 'running', '等待 API 数据...');

    // 页面初次加载可能走 protobuf 通道（bridge 无法解析），
    // 需要触发用户交互来强制页面发出 JSON API 请求
    if (scope.trigger) {
      await sleep(3000);
      updateProgress(scopeKey, 'running', '触发 JSON API...');
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: scope.trigger.action,
          scope: scope.trigger.scope,
        });
      } catch (e) {
        console.warn('[panel] trigger failed:', e);
      }
      await sleep(3000);
    }

    // 笔记数据需要自动翻页，逐页点击"下一页"让 bridge 累加 note_infos
    if (scopeKey === 'notes') {
      updateProgress(scopeKey, 'running', '自动翻页中...');
      try {
        const pageResp = await chrome.tabs.sendMessage(tab.id, { type: 'PAGINATE_NOTES' });
        if (pageResp?.success && pageResp.pagesLoaded > 0) {
          updateProgress(scopeKey, 'running', `翻了 ${pageResp.pagesLoaded} 页，正在汇总...`);
        }
      } catch (e) {
        console.warn('[panel] paginate failed:', e);
      }
      await sleep(2000);
    }

    let cachedData = {};
    let lastError = '';
    for (let attempt = 1; attempt <= 10; attempt++) {
      await sleep(attempt <= 3 ? 2000 : 3000);

      try {
        const resp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_ALL_CACHED' });
        if (resp?.success && resp.data && Object.keys(resp.data).length > 0) {
          cachedData = resp.data;
          break;
        }
        if (resp && !resp.success) {
          lastError = resp.error || 'unknown';
        }
      } catch (e) {
        lastError = e.message;
      }

      updateProgress(scopeKey, 'running', `等待数据中... (${attempt}/10)`);
    }

    const count = Object.keys(cachedData).length;
    if (count > 0) {
      const keys = Object.keys(cachedData).map(k => k.split('/').pop()).join(', ');
      updateProgress(scopeKey, 'done', `拦截到 ${count} 个: ${keys}`);
    } else {
      updateProgress(scopeKey, 'fail', `未拦截到数据${lastError ? ' (' + lastError + ')' : ''}`);
    }

    return cachedData;
  }

  async function findXhsTab() {
    const tabs = await chrome.tabs.query({ url: 'https://creator.xiaohongshu.com/*' });
    return tabs.length > 0 ? tabs[0] : null;
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

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ===== Progress =====
  function initProgress(scopeKeys) {
    progressCard.style.display = 'block';
    progressList.innerHTML = '';
    for (const key of scopeKeys) {
      const item = document.createElement('div');
      item.className = 'progress-item';
      item.id = `prog-${key}`;
      item.innerHTML = `
        <span class="pi-icon">⏳</span>
        <span class="pi-label">${SCOPES[key]?.label || key}</span>
        <span class="pi-status">等待中</span>
      `;
      progressList.appendChild(item);
    }
  }

  function updateProgress(key, status, detail) {
    const item = document.getElementById(`prog-${key}`);
    if (!item) return;
    const icon = item.querySelector('.pi-icon');
    const statusEl = item.querySelector('.pi-status');
    item.className = 'progress-item';
    if (status === 'running') {
      item.classList.add('running');
      icon.textContent = '⟳';
      statusEl.textContent = detail || '请求中...';
    } else if (status === 'done') {
      item.classList.add('done');
      icon.textContent = '✓';
      statusEl.textContent = detail || '完成';
    } else if (status === 'fail') {
      item.classList.add('fail');
      icon.textContent = '✕';
      statusEl.textContent = detail || '失败';
    }
  }

  function showError(msg) {
    progressCard.style.display = 'block';
    const item = document.createElement('div');
    item.className = 'progress-item fail';
    item.innerHTML = `
      <span class="pi-icon">✕</span>
      <span class="pi-label">${escapeHtml(msg)}</span>
      <span class="pi-status"></span>
    `;
    progressList.appendChild(item);
  }

  // ===== Preview =====
  function showPreview(data) {
    previewCard.style.display = 'block';
    previewTabs.innerHTML = '';
    previewContent.textContent = '';

    // data = { scopeKey: { apiPath: responseData, ... }, ... }
    const flatEntries = [];
    for (const [scopeKey, scopeData] of Object.entries(data)) {
      if (!scopeData || typeof scopeData !== 'object') continue;
      for (const [apiPath, apiData] of Object.entries(scopeData)) {
        flatEntries.push({
          label: `${SCOPES[scopeKey]?.label || scopeKey} / ${apiPath.split('/').pop()}`,
          data: apiData
        });
      }
    }

    if (flatEntries.length === 0) {
      previewContent.textContent = '没有获取到数据';
      return;
    }

    for (let i = 0; i < flatEntries.length; i++) {
      const entry = flatEntries[i];
      const tab = document.createElement('div');
      tab.className = 'preview-tab';
      tab.textContent = entry.label;
      tab.addEventListener('click', () => {
        document.querySelectorAll('.preview-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        previewContent.innerHTML = syntaxHighlight(JSON.stringify(entry.data, null, 2));
      });
      previewTabs.appendChild(tab);
      if (i === 0) {
        tab.classList.add('active');
        previewContent.innerHTML = syntaxHighlight(JSON.stringify(entry.data, null, 2));
      }
    }
  }

  function syntaxHighlight(json) {
    return escapeHtml(json).replace(
      /("(\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      (match) => {
        let cls = 'number';
        if (/^"/.test(match)) cls = /:$/.test(match) ? 'key' : 'string';
        else if (/true|false|null/.test(match)) cls = 'null';
        return `<span class="${cls}">${match}</span>`;
      }
    );
  }

  // ===== Save Config =====
  saveBtn.addEventListener('click', async () => {
    await chrome.storage.local.set({
      appId: document.getElementById('appId').value.trim(),
      appSecret: document.getElementById('appSecret').value.trim(),
      bitableUrl: document.getElementById('bitableUrl').value.trim(),
      noteTableName: document.getElementById('noteTableName').value.trim(),
      accountTableName: document.getElementById('accountTableName').value.trim(),
      accountName: document.getElementById('accountName').value.trim(),
    });
    saveBtn.textContent = '已保存 ✓';
    setTimeout(() => { saveBtn.textContent = '保存配置'; }, 1500);
  });

  // ===== Sync to Feishu =====
  syncBtn.addEventListener('click', async () => {
    if (!lastFetchedData) { alert('请先获取数据'); return; }
    const appId = document.getElementById('appId').value.trim();
    const appSecret = document.getElementById('appSecret').value.trim();
    const bitableUrl = document.getElementById('bitableUrl').value.trim();
    if (!appId || !appSecret || !bitableUrl) {
      alert('请填写飞书 App ID、App Secret 和多维表格链接');
      return;
    }

    syncBtn.disabled = true;
    syncBtn.textContent = '同步中...';

    try {
      const accountName = document.getElementById('accountName').value.trim();
      await chrome.storage.local.set({ appId, appSecret, bitableUrl, accountName });
      const config = {
        appId, appSecret, bitableUrl, accountName,
        noteTableName: document.getElementById('noteTableName').value.trim() || '笔记数据',
        accountTableName: document.getElementById('accountTableName').value.trim() || '账号数据',
      };

      const tableMode = document.querySelector('input[name="tableMode"]:checked').value;

      // 选了"新建表"时，先创建表
      if (tableMode === 'create') {
        syncBtn.textContent = '正在创建表...';
        const createResp = await chrome.runtime.sendMessage({
          type: 'CREATE_TABLES', config
        });
        if (createResp.success) {
          const { created, skipped } = createResp.result;
          if (created.length > 0) showInfo(`已创建: ${created.join(', ')}`);
          if (skipped.length > 0) showInfo(`已存在(跳过): ${skipped.join(', ')}`);
        } else {
          syncBtn.textContent = '建表失败 ✕';
          showError(createResp.error);
          return;
        }
        syncBtn.textContent = '正在写入数据...';
      }

      const response = await chrome.runtime.sendMessage({
        type: 'WRITE_TO_FEISHU', config, data: lastFetchedData
      });

      if (response.success) {
        const r = response.result;
        syncBtn.textContent = `完成 ✓ 新增${r.written} 更新${r.updated}`;
        if (r.written > 0 || r.updated > 0) {
          showInfo(`同步完成：新增 ${r.written} 条，更新 ${r.updated} 条`);
          if (r.details?.notes) {
            showInfo(`笔记数据：新增 ${r.details.notes.written} 条，更新 ${r.details.notes.updated} 条`);
          }
          if (r.details?.account) {
            showInfo(`账号数据：新增 ${r.details.account.written} 条，更新 ${r.details.account.updated} 条`);
          }
        }
        if (r.errors?.length > 0) r.errors.forEach(e => showError(e));
        if (r.written === 0 && r.updated === 0 && r.errors.length === 0) {
          const scopes = r.debug?.receivedScopes || {};
          const scopeInfo = Object.entries(scopes)
            .map(([k, v]) => `${k}: ${v.length > 0 ? v.join(', ') : '(空)'}`)
            .join('; ');
          showError(`未匹配到可写入的数据。收到的数据: ${scopeInfo || '无'}`);
        }
      } else {
        syncBtn.textContent = '失败 ✕';
        showError(response.error);
      }
    } catch (err) {
      syncBtn.textContent = '失败 ✕';
      showError(err.message);
    } finally {
      setTimeout(() => {
        syncBtn.disabled = false;
        syncBtn.textContent = '同步到飞书';
      }, 3000);
    }
  });

  function showInfo(msg) {
    progressCard.style.display = 'block';
    const item = document.createElement('div');
    item.className = 'progress-item done';
    item.innerHTML = `
      <span class="pi-icon">✓</span>
      <span class="pi-label">${escapeHtml(msg)}</span>
      <span class="pi-status"></span>
    `;
    progressList.appendChild(item);
  }

  // 从 bridge 缓存数据中提取 userName
  // info API 的响应格式: { data: { userName: "Pi", userId: "...", ... } }
  function extractUserName(allData) {
    for (const scopeData of Object.values(allData)) {
      if (!scopeData || typeof scopeData !== 'object') continue;
      for (const [path, resp] of Object.entries(scopeData)) {
        const d = resp?.data || resp;
        if (d?.userName) return d.userName;
      }
    }
    return '';
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
});
