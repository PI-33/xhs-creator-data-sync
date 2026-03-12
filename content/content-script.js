console.log('[XHS-Sync] Content script loaded on', window.location.href);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PING') {
    sendResponse({ success: true, url: window.location.href });
    return true;
  }

  if (message.type === 'GET_ALL_CACHED') {
    getAllCached()
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'CLICK_TAB') {
    clickTab(message.tabName)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'TRIGGER_JSON_API') {
    triggerJsonApi(message.scope)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'PAGINATE_NOTES') {
    paginateNotes()
      .then(result => sendResponse({ success: true, ...result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

});

function getAllCached() {
  return new Promise((resolve, reject) => {
    const handler = (event) => {
      if (event.source !== window) return;
      if (event.data?.type !== 'XHS_BRIDGE_CACHE_DUMP_RESPONSE') return;
      window.removeEventListener('message', handler);
      clearTimeout(timer);
      console.log('[XHS-Sync] Got cache dump, keys:', event.data.keys);
      resolve(event.data.data || {});
    };

    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('Bridge 未响应'));
    }, 5000);

    window.addEventListener('message', handler);
    window.postMessage({ type: 'XHS_BRIDGE_CACHE_DUMP' }, '*');
  });
}

// 页面初次加载用 protobuf 通道，bridge 无法解析
// 通过模拟用户交互触发 JSON API
async function triggerJsonApi(scope) {
  const delay = ms => new Promise(r => setTimeout(r, ms));

  // 通用策略：先找所有 tab 和可点击元素
  const tabSelectors = [
    '.d-tabs-nav-horizontal .d-tab-nav-item',
    '.d-tab-nav .d-tab-nav-item',
    '[role="tab"]',
    '.tabs .tab-item',
  ];

  function findTabsByText(...texts) {
    const found = {};
    for (const selector of tabSelectors) {
      for (const el of document.querySelectorAll(selector)) {
        const t = el.textContent.trim();
        for (const text of texts) {
          if (t.includes(text)) found[text] = el;
        }
      }
    }
    return found;
  }

  if (scope === 'account') {
    // 账号概览页：点击日期 tab 触发 JSON API
    const tabs = findTabsByText('近30天', '30天', '近7天', '7天');
    const target = tabs['近30天'] || tabs['30天'];
    if (target) {
      console.log('[XHS-Sync] Clicking account tab:', target.textContent.trim());
      target.click();
    } else {
      clickAnyNonActiveTab();
    }
  } else if (scope === 'fans') {
    // 粉丝数据页：点击 "近30天" 触发 /api/galaxy/creator/data/fans/overall_new
    const tabs = findTabsByText('近30天', '30天', '近7天', '7天');
    const target = tabs['近30天'] || tabs['30天'];
    if (target) {
      console.log('[XHS-Sync] Clicking fans tab:', target.textContent.trim());
      target.click();
    } else {
      console.warn('[XHS-Sync] No fans tab found, trying all tab-like elements');
      clickAnyNonActiveTab();
    }
  } else if (scope === 'notes') {
    // 内容分析页：点击 "近30天" 或 "近7天" tab
    const tabs = findTabsByText('近30天', '30天', '近7天', '7天');
    const target = tabs['近30天'] || tabs['30天'] || tabs['近7天'] || tabs['7天'];
    if (target) {
      console.log('[XHS-Sync] Clicking notes tab:', target.textContent.trim());
      target.click();
    } else {
      console.warn('[XHS-Sync] No notes tab found, trying all tab-like elements');
      clickAnyNonActiveTab();
    }
  }

  await delay(2000);
  console.log('[XHS-Sync] triggerJsonApi done for scope:', scope);
}

// 自动翻页：反复点击"下一页"，直到没有更多页
async function paginateNotes() {
  const delay = ms => new Promise(r => setTimeout(r, ms));
  let pagesLoaded = 0;
  const MAX_PAGES = 50;

  for (let i = 0; i < MAX_PAGES; i++) {
    // 找"下一页"按钮（未禁用的）
    const nextBtn = findNextPageButton();
    if (!nextBtn) {
      console.log('[XHS-Sync] No more pages, stopping at page', i + 1);
      break;
    }

    nextBtn.click();
    pagesLoaded++;
    console.log('[XHS-Sync] Clicked next page, now loading page', pagesLoaded + 1);
    await delay(2500);
  }

  return { pagesLoaded };
}

function findNextPageButton() {
  // d-pager 组件的"下一页"按钮
  const selectors = [
    '.d-pager .d-pager-next:not(.disabled):not([disabled])',
    '.d-pager-next:not(.disabled):not([disabled])',
    'button.d-pager-next:not([disabled])',
    'li.d-pager-next:not(.disabled)',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }

  // 兜底：找含"下一页"文字或 > 箭头的按钮
  for (const el of document.querySelectorAll('button, li, a, span')) {
    const text = el.textContent.trim();
    if ((text === '>' || text === '下一页' || text === '›') &&
        !el.classList.contains('disabled') && !el.disabled &&
        el.offsetParent !== null) {
      return el;
    }
  }
  return null;
}

function clickAnyNonActiveTab() {
  const allTabs = document.querySelectorAll(
    '.d-tab-nav-item:not(.active), [role="tab"]:not([aria-selected="true"])'
  );
  if (allTabs.length > 0) {
    console.log('[XHS-Sync] Clicking fallback tab:', allTabs[0].textContent.trim());
    allTabs[0].click();
  }
}

function clickTab(tabName) {
  return new Promise((resolve, reject) => {
    const selectors = [
      '.d-tabs-nav-horizontal .d-tab-nav-item',
      '.d-tab-nav .d-tab-nav-item',
      '.tab-nav .tab-item',
      '[role="tab"]',
    ];

    let clicked = false;
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (el.textContent.trim() === tabName || el.textContent.includes(tabName)) {
          el.click();
          clicked = true;
          break;
        }
      }
      if (clicked) break;
    }

    if (!clicked) {
      for (const el of document.querySelectorAll('div, span, a, li, button')) {
        const text = el.textContent.trim();
        if (text === tabName && el.offsetParent !== null && el.children.length <= 2 && text.length < 20) {
          el.click();
          clicked = true;
          break;
        }
      }
    }

    if (clicked) {
      setTimeout(resolve, 2000);
    } else {
      reject(new Error(`未找到 "${tabName}" tab`));
    }
  });
}
