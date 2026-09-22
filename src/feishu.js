import { chunk, requestJson } from "./http.js";

const API_BASE = "https://open.feishu.cn/open-apis";

function assertFeishuSuccess(response, action) {
  if (response?.code !== 0) {
    throw new Error(`${action}失败：code=${response?.code}, msg=${response?.msg || "未知错误"}`);
  }
  return response.data;
}

export class FeishuClient {
  constructor({ appId, appSecret, appToken, wikiNodeToken, tableId, timezoneOffset = "+08:00" }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.appToken = appToken;
    this.wikiNodeToken = wikiNodeToken;
    this.tableId = tableId;
    this.timezoneOffset = timezoneOffset;
    this.accessToken = "";
    this.fieldMap = null;
  }

  async authenticate() {
    const response = await requestJson(`${API_BASE}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    if (response.code !== 0 || !response.tenant_access_token) {
      throw new Error(`飞书鉴权失败：${response.msg || "未返回 tenant_access_token"}`);
    }
    this.accessToken = response.tenant_access_token;
    return this.accessToken;
  }

  async request(pathname, options = {}) {
    if (!this.accessToken) await this.authenticate();
    const response = await requestJson(`${API_BASE}${pathname}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        ...(options.headers || {}),
      },
    });
    return response;
  }

  async resolveAppToken() {
    if (this.appToken) return this.appToken;
    if (!this.wikiNodeToken) throw new Error("缺少 FEISHU_APP_TOKEN 或 FEISHU_WIKI_NODE_TOKEN");
    const response = await this.request(`/wiki/v2/spaces/get_node?token=${encodeURIComponent(this.wikiNodeToken)}`);
    const data = assertFeishuSuccess(response, "解析 Wiki 节点");
    this.appToken = data?.node?.obj_token || "";
    if (!this.appToken) throw new Error("Wiki 节点未返回多维表格 app_token（obj_token）");
    return this.appToken;
  }

  async listFields() {
    const appToken = await this.resolveAppToken();
    const fields = [];
    let pageToken = "";
    do {
      const query = new URLSearchParams({ page_size: "100" });
      if (pageToken) query.set("page_token", pageToken);
      const response = await this.request(
        `/bitable/v1/apps/${appToken}/tables/${this.tableId}/fields?${query.toString()}`,
      );
      const data = assertFeishuSuccess(response, "读取飞书字段");
      fields.push(...(data?.items || []));
      pageToken = data?.has_more ? data.page_token || "" : "";
    } while (pageToken);
    this.fieldMap = new Map(fields.map((field) => [field.field_name, field]));
    return this.fieldMap;
  }

  async listRecords() {
    const appToken = await this.resolveAppToken();
    const records = [];
    let pageToken = "";
    do {
      const query = new URLSearchParams({ page_size: "500" });
      if (pageToken) query.set("page_token", pageToken);
      const response = await this.request(
        `/bitable/v1/apps/${appToken}/tables/${this.tableId}/records?${query.toString()}`,
      );
      const data = assertFeishuSuccess(response, "读取飞书记录");
      records.push(...(data?.items || []));
      pageToken = data?.has_more ? data.page_token || "" : "";
    } while (pageToken);
    return records;
  }

  async listTables() {
    const token = await this.resolveAppToken();
    const tables = [];
    let page = "";
    do {
      const query = new URLSearchParams({ page_size: "100", ...(page ? { page_token: page } : {}) });
      const data = assertFeishuSuccess(await this.request(`/bitable/v1/apps/${token}/tables?${query}`), "读取数据表");
      tables.push(...(data?.items || []));
      if (data?.has_more && (!data.page_token || data.page_token === page)) throw new Error("数据表分页不完整");
      page = data?.has_more ? data.page_token : "";
    } while (page);
    return tables;
  }

  async createTable(name, fields) {
    const token = await this.resolveAppToken();
    return assertFeishuSuccess(await this.request(`/bitable/v1/apps/${token}/tables`, {
      method: "POST", body: JSON.stringify({ table: { name, fields } }),
    }), "创建数据表");
  }

  async createField(field) {
    const token = await this.resolveAppToken();
    const data = assertFeishuSuccess(await this.request(`/bitable/v1/apps/${token}/tables/${this.tableId}/fields`, {
      method: "POST", body: JSON.stringify(field),
    }), "创建字段");
    this.fieldMap = null;
    return data?.field;
  }

  async updateField(fieldId, field) {
    const token = await this.resolveAppToken();
    const response = await this.request(`/bitable/v1/apps/${token}/tables/${this.tableId}/fields/${fieldId}`, {
      method: "PUT", body: JSON.stringify(field),
    });
    if (response?.code === 1254606 && response?.msg === "DataNotChange") return response.data;
    return assertFeishuSuccess(response, "更新字段");
  }

  dateToTimestamp(value, fieldName, allFields) {
    if (typeof value === "number") return value;
    if (!value) return value;
    if (fieldName === "Start time" && /^\d{1,2}:\d{2}/.test(String(value))) {
      const date = allFields["From date"] || new Date().toISOString().slice(0, 10);
      return Date.parse(`${date}T${String(value).slice(0, 5)}:00${this.timezoneOffset}`);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
      return Date.parse(`${value}T00:00:00${this.timezoneOffset}`);
    }
    const timestamp = Date.parse(String(value));
    if (Number.isNaN(timestamp)) throw new Error(`字段 ${fieldName} 无法转换为日期：${value}`);
    return timestamp;
  }

  serializeFields(fields) {
    if (!this.fieldMap) throw new Error("写入前必须先调用 listFields()");
    const result = {};
    for (const [fieldName, value] of Object.entries(fields)) {
      if (value === "" || value == null) continue;
      const schema = this.fieldMap.get(fieldName);
      if (!schema) continue;
      if (schema.type === 5) {
        result[fieldName] = this.dateToTimestamp(value, fieldName, fields);
      } else if (schema.type === 15) {
        result[fieldName] = typeof value === "string" ? { text: value, link: value } : value;
      } else if (schema.type === 2) {
        const number = Number(value);
        if (!Number.isFinite(number)) throw new Error(`字段 ${fieldName} 不是有效数字：${value}`);
        result[fieldName] = number;
      } else {
        result[fieldName] = typeof value === "string" ? value : JSON.stringify(value);
      }
    }
    return result;
  }

  async batchCreate(rows) {
    const appToken = await this.resolveAppToken();
    const created = [];
    for (const group of chunk(rows, 500)) {
      const response = await this.request(
        `/bitable/v1/apps/${appToken}/tables/${this.tableId}/records/batch_create`,
        { method: "POST", body: JSON.stringify({ records: group.map((row) => ({ fields: row.fields })) }) },
      );
      const data = assertFeishuSuccess(response, "批量新增记录");
      created.push(...(data?.records || []));
    }
    return created;
  }

  async batchUpdate(rows) {
    const appToken = await this.resolveAppToken();
    for (const group of chunk(rows, 500)) {
      const response = await this.request(
        `/bitable/v1/apps/${appToken}/tables/${this.tableId}/records/batch_update`,
        {
          method: "POST",
          body: JSON.stringify({
            records: group.map((row) => ({ record_id: row.recordId, fields: row.fields })),
          }),
        },
      );
      assertFeishuSuccess(response, "批量更新记录");
    }
  }

  async batchDelete(recordIds) {
    const appToken = await this.resolveAppToken();
    for (const group of chunk(recordIds, 500)) {
      const response = await this.request(
        `/bitable/v1/apps/${appToken}/tables/${this.tableId}/records/batch_delete`,
        { method: "POST", body: JSON.stringify({ records: group }) },
      );
      assertFeishuSuccess(response, "批量删除记录");
    }
  }
}
