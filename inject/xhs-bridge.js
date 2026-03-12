(() => {
  if (window.__xhsBridgeInstalled) return;
  window.__xhsBridgeInstalled = true;

  const TAG = '[XHS-Bridge]';
  const responseCache = {};
  const waiters = {};

  // Patterns to intercept - broad enough to catch all XHS API calls
  const INTERCEPT_PATTERNS = [
    '/api/galaxy/',
    '/api/cas/',
    '/api/datacenter/',
    '/api/creator/',
    'faas/proto/',
  ];

  function shouldIntercept(url) {
    return INTERCEPT_PATTERNS.some(p => url.includes(p));
  }

  console.log(TAG, 'Installing hooks...');

  // =============================================
  // HOOK XMLHttpRequest
  // =============================================
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._bUrl = String(url);
    this._bMethod = method;
    return xhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this._bUrl && shouldIntercept(this._bUrl)) {
      const key = toKey(this._bUrl);
      console.log(TAG, 'XHR:', this._bMethod, key);

      this.addEventListener('load', function () {
        if (this.status >= 200 && this.status < 300) {
          try {
            const data = JSON.parse(this.responseText);
            store(key, this.status, data);
          } catch (e) {
            console.warn(TAG, 'XHR JSON parse failed:', key, 'length:', this.responseText?.length, 'preview:', this.responseText?.substring(0, 100));
          }
        } else {
          console.warn(TAG, 'XHR non-ok:', key, 'status:', this.status);
        }
      });
    }
    return xhrSend.call(this, body);
  };

  // =============================================
  // HOOK fetch
  // =============================================
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    const p = origFetch.call(this, input, init);

    if (url && shouldIntercept(url)) {
      const key = toKey(url);
      console.log(TAG, 'fetch:', key);

      p.then(resp => {
        if (resp.ok) {
          return resp.clone().text().then(text => {
            try {
              const d = JSON.parse(text);
              store(key, resp.status, d);
            } catch (e) {
              console.warn(TAG, 'fetch JSON parse failed:', key, 'length:', text?.length, 'preview:', text?.substring(0, 100));
            }
          }).catch(() => {});
        }
      }).catch(() => {});
    }

    return p;
  };

  // =============================================
  // Helpers
  // =============================================
  function toKey(url) {
    try {
      const u = new URL(url, location.origin);
      return u.pathname;
    } catch (e) {
      return url.split('?')[0];
    }
  }

  function store(key, status, data) {
    console.log(TAG, 'Cached:', key);

    // 笔记分析 API 翻页时 pathname 相同，需要累加 note_infos
    const existing = responseCache[key];
    if (existing && data?.data?.note_infos && existing.data?.data?.note_infos) {
      const seen = new Set(existing.data.data.note_infos.map(n => n.id));
      const newNotes = data.data.note_infos.filter(n => !seen.has(n.id));
      existing.data.data.note_infos.push(...newNotes);
      existing.data.data.total = data.data.total;
      existing.ts = Date.now();
      console.log(TAG, 'Merged note_infos, total now:', existing.data.data.note_infos.length);
    } else {
      responseCache[key] = { status, data, ts: Date.now() };
    }

    const list = waiters[key];
    if (list && list.length > 0) {
      console.log(TAG, 'Resolving', list.length, 'waiter(s) for', key);
      const merged = responseCache[key];
      for (const fn of list) fn({ status: merged.status, data: merged.data });
      delete waiters[key];
    }
  }

  function getCached(key, maxAgeMs) {
    const c = responseCache[key];
    if (c && (Date.now() - c.ts) < maxAgeMs) return c;
    return null;
  }

  function waitFor(key, timeoutMs) {
    return new Promise((resolve, reject) => {
      const cached = getCached(key, 300000);
      if (cached) { resolve({ status: cached.status, data: cached.data }); return; }

      if (!waiters[key]) waiters[key] = [];
      const timer = setTimeout(() => {
        const arr = waiters[key];
        if (arr) {
          const idx = arr.indexOf(resolveFn);
          if (idx >= 0) arr.splice(idx, 1);
          if (!arr.length) delete waiters[key];
        }
        reject(new Error(`等待超时: ${key}`));
      }, timeoutMs);

      function resolveFn(result) { clearTimeout(timer); resolve(result); }
      waiters[key].push(resolveFn);
    });
  }

  // =============================================
  // Bridge message handler
  // =============================================
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;

    if (msg?.type === 'XHS_BRIDGE_REQUEST') {
      const { requestId, url } = msg;
      const key = toKey(url);
      try {
        const result = await waitFor(key, 25000);
        reply(requestId, true, result.status, result.data);
      } catch (err) {
        reply(requestId, false, 0, null, err.message);
      }
    }

    if (msg?.type === 'XHS_BRIDGE_CACHE_DUMP') {
      const keys = Object.keys(responseCache);
      console.log(TAG, 'Cache dump:', keys);
      window.postMessage({
        type: 'XHS_BRIDGE_CACHE_DUMP_RESPONSE',
        keys,
        data: Object.fromEntries(
          Object.entries(responseCache).map(([k, v]) => [k, v.data])
        )
      }, '*');
    }
  });

  function reply(requestId, success, status, data, error) {
    window.postMessage({ type: 'XHS_BRIDGE_RESPONSE', requestId, success, status, data, error }, '*');
  }

  console.log(TAG, 'Hooks installed');
})();
