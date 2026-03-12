const FeishuApi = {
  BASE: 'https://open.feishu.cn/open-apis',
  token: null,
  tokenExpiry: 0,

  configure(appId, appSecret) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.token = null;
    this.tokenExpiry = 0;
  },

  async getToken() {
    if (this.token && Date.now() < this.tokenExpiry) {
      return this.token;
    }
    const resp = await fetch(`${this.BASE}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: this.appId,
        app_secret: this.appSecret
      })
    });
    const data = await resp.json();
    if (data.code !== 0) {
      throw new Error(`飞书认证失败: ${data.msg}`);
    }
    this.token = data.tenant_access_token;
    this.tokenExpiry = Date.now() + (data.expire - 60) * 1000;
    return this.token;
  },

  async _request(method, path, body) {
    const token = await this.getToken();
    const opts = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(`${this.BASE}${path}`, opts);
    const data = await resp.json();
    if (data.code !== 0) {
      throw new Error(`飞书 API 错误 [${path}]: ${data.msg}`);
    }
    return data.data;
  },

  // ===== Bitable APIs =====

  async listTables(appToken) {
    return this._request('GET', `/bitable/v1/apps/${appToken}/tables`);
  },

  async getTableFields(appToken, tableId) {
    return this._request('GET', `/bitable/v1/apps/${appToken}/tables/${tableId}/fields`);
  },

  async listRecords(appToken, tableId, pageSize = 100, pageToken) {
    let path = `/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=${pageSize}`;
    if (pageToken) path += `&page_token=${pageToken}`;
    return this._request('GET', path);
  },

  async batchCreateRecords(appToken, tableId, records) {
    return this._request('POST',
      `/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`,
      { records }
    );
  },

  async updateRecord(appToken, tableId, recordId, fields) {
    return this._request('PUT',
      `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
      { fields }
    );
  },

  async batchUpdateRecords(appToken, tableId, records) {
    return this._request('POST',
      `/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_update`,
      { records }
    );
  },

  async searchRecords(appToken, tableId, filter) {
    return this._request('POST',
      `/bitable/v1/apps/${appToken}/tables/${tableId}/records/search`,
      { filter, automatic_fields: true }
    );
  },

  async createTable(appToken, name, fields) {
    return this._request('POST',
      `/bitable/v1/apps/${appToken}/tables`,
      { table: { name, default_view_name: '默认视图', fields } }
    );
  },

  async addField(appToken, tableId, fieldDef) {
    return this._request('POST',
      `/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
      fieldDef
    );
  }
};
