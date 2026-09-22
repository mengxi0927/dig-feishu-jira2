export const textValue = value => Array.isArray(value) ? value.map(x => x.text || "").join("") : String(value ?? "");

export async function ensureFields(client, definitions, create = false) {
  let fields = await client.listFields();
  for (const field of definitions) {
    if (!fields.has(field.field_name) && create) {
      await client.createField(field);
      fields = await client.listFields();
    }
    const found = fields.get(field.field_name);
    if (!found || found.type !== field.type) throw new Error(`表 ${client.tableId} 字段 ${field.field_name} 缺失或类型不匹配`);
  }
  return fields;
}

// Remote keys make retries safe even if create succeeded but the response was lost.
export async function appendOnce(client, rows, keyField) {
  if (!rows.length) return { created: 0, skipped: 0 };
  await client.listFields();
  const existing = new Map();
  for (const record of await client.listRecords()) {
    const key = textValue(record.fields[keyField]);
    if (!key) continue;
    if (existing.has(key)) throw new Error(`表 ${client.tableId} 存在重复同步键 ${key}`);
    existing.set(key, record);
  }
  const pending = rows.filter(row => !existing.has(row.key));
  const result = await client.batchCreate(pending.map(row => ({ fields: client.serializeFields({ ...row.fields, [keyField]: row.key }) })));
  if (result.length !== pending.length || result.some(r => !r.record_id)) throw new Error("新增返回不完整，重试时将按远端同步键恢复");
  return { created: pending.length, skipped: rows.length - pending.length };
}

export function cloneDefinition(field, ids) {
  const replace = value => {
    if (typeof value === "string") return value.replace(/\b(?:tbl|fld)[A-Za-z0-9]+\b/g, id => ids.get(id) || id);
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]));
    return value;
  };
  const property = replace(field.property || {});
  // Lookup columns are not editable through the field API in this deployment.
  // Their returned expression can be reproduced as a formula in NEW month tables.
  if (field.type === 19) {
    if (!property.formula) throw new Error(`查找引用字段 ${field.field_name} 缺少可复制表达式`);
    return { field_name: field.field_name, type: 20, ui_type: "Formula",
      property: { formula_expression: property.formula, ...(property.formatter ? { formatter: property.formatter } : {}) } };
  }
  delete property.type; // API-computed result type, not an editable formula property.
  if (property.options) property.options = property.options.map(({ id, ...option }) => option);
  return { field_name: field.field_name, type: field.type, ...(field.ui_type ? { ui_type: field.ui_type } : {}),
    ...(Object.keys(property).length ? { property } : {}) };
}

// Build all column IDs first, then remap formulas/lookups to the new table.
// Can resume a partially created schema by matching field names.
export async function cloneSchema(template, target) {
  const source = [...(await template.listFields()).values()];
  let dest = await target.listFields();
  for (const field of source) {
    if (!dest.has(field.field_name)) {
      await target.createField({ field_name: field.field_name, type: 1 });
      dest = await target.listFields();
    }
  }
  const ids = new Map([[template.tableId, target.tableId]]);
  for (const field of source) ids.set(field.field_id, dest.get(field.field_name).field_id);
  for (const field of source) {
    try { await target.updateField(ids.get(field.field_id), cloneDefinition(field, ids)); }
    catch (error) { throw new Error(`复制字段 ${field.field_name} (type=${field.type})：${error.message}`, { cause: error }); }
  }
  const verified = await target.listFields();
  for (const field of source) {
    if (verified.get(field.field_name)?.type !== cloneDefinition(field, ids).type) throw new Error(`月表字段复制失败：${field.field_name}`);
    const property = JSON.stringify(verified.get(field.field_name).property || {});
    if (property.includes(template.tableId)) throw new Error(`月表字段仍引用模板：${field.field_name}`);
  }
}
