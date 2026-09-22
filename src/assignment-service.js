import { FeishuClient } from "./feishu.js";
import { JiraClient } from "./jira.js";
import { StateStore } from "./state.js";
import { withSyncWriteGuard } from "./sync-guard.js";
import { dailySourceKey, transformDailyPlans } from "./transform.js";
import { adjustmentRows, changes, digest, periodStart, replaceRange, scheduleRange, shiftDay, snapshotPlans } from "./assignment-model.js";
import { appendOnce, cloneSchema, ensureFields, textValue } from "./assignment-tables.js";

const textField = field_name => ({ field_name, type: 1 });
const LOG_FIELDS = [textField("allocationId"), textField("派工识别id"), textField("变更事件ID"), textField("来源唯一键"),
  { field_name: "工时日期", type: 5 }, { field_name: "变更前工时", type: 2 }, { field_name: "变更后工时", type: 2 },
  { field_name: "派工状态", type: 3, property: { options: ["新增", "修改", "删除"].map(name => ({ name })) } }];
const BACKFILL_FIELDS = [textField("项目号"), textField("姓名"), textField("派工识别id"), textField("同步明细键"),
  textField("调整期间"), { field_name: "日期", type: 5 }, { field_name: "补录工时（小时）", type: 2 }];

function recordDay(value) {
  if (typeof value === "number") return new Date(value + 8 * 3600000).toISOString().slice(0, 10);
  return textValue(value).slice(0, 10);
}
function recordKey(record) {
  return dailySourceKey(recordDay(record.fields["日期"]), textValue(record.fields["项目号"]), textValue(record.fields["姓名"]));
}
function normalIndex(records) {
  const index = new Map();
  for (const record of records) {
    const key = recordKey(record);
    if (index.has(key)) throw new Error(`工时信息存在重复汇总键：${key}`);
    index.set(key, record);
  }
  return index;
}

export function createAssignmentService(config, dependencies = {}) {
  const jira = dependencies.jira || new JiraClient({ baseUrl: config.jiraBaseUrl, username: config.jiraUsername, password: config.jiraPassword });
  const client = dependencies.client || (tableId => new FeishuClient({
    appId: config.feishuAppId, appSecret: config.feishuAppSecret, appToken: config.feishuAppToken,
    wikiNodeToken: config.feishuWikiNodeToken, tableId, timezoneOffset: config.timezoneOffset,
  }));
  const now = dependencies.now || (() => new Date());
  const store = () => new StateStore(config.stateFile).load();
  const hoursField = config.feishuDailyHoursField || "工时（小时）";
  const templateId = config.feishuBackfillTemplateTableId;
  const normalFields = [textField("项目号"), textField("姓名"), textField("派工识别id"),
    { field_name: "日期", type: 5 }, { field_name: hoursField, type: 2 }];
  function validateConfiguration() {
    if (!config.feishuTableId || !config.feishuDailyTableId || !templateId) throw new Error("缺少派工、工时或补录模板表 ID");
    if (new Set([config.feishuTableId, config.feishuDailyTableId, templateId]).size !== 3) throw new Error("三个目标表 ID 必须不同");
  }
  function validateExecutionDate(cutoff) {
    const today = new Date(now().getTime() + 8 * 3600000).toISOString().slice(0, 10);
    if (cutoff !== shiftDay(today, -1)) throw new Error("正式执行的 date 必须为北京时间昨天；历史日期仅允许预览");
  }

  async function collect(cutoff, old) {
    const range = scheduleRange(cutoff, old);
    const fetchPlans = (jira.fetchPlanAllocationsRange || jira.fetchPlansRange).bind(jira);
    let plans = await fetchPlans(range.from, cutoff);
    let current = await snapshotPlans(plans, jira);
    for (const entry of Object.values(current)) if (entry.plan.day < range.from || entry.plan.day > cutoff) throw new Error("Jira 返回查询范围外数据");
    // A missing daily contribution may have moved outside the 30-day window.
    // Expand to the full year before classifying it, instead of treating window exit as deletion.
    if (old?.initialized && range.from > range.yearStart && Object.entries(old.observed).some(([key, entry]) =>
      entry.plan.day >= range.from && entry.plan.day <= cutoff && !current[key])) {
      range.from = range.yearStart;
      plans = await fetchPlans(range.from, cutoff);
      current = await snapshotPlans(plans, jira);
      for (const entry of Object.values(current)) if (entry.plan.day < range.from || entry.plan.day > cutoff) throw new Error("Jira 返回查询范围外数据");
    }
    const latest = replaceRange(old?.observed || {}, current, range.from, cutoff);
    const revision = (old?.revision || 0) + 1;
    const events = changes(old?.observed || {}, latest, revision);
    const normalPlans = Object.values(latest).filter(x => x.plan.day >= range.openFrom && x.plan.day <= cutoff).map(x => x.plan);
    const daily = await transformDailyPlans(normalPlans, jira, { includeAllocationIds: true });
    if (daily.errors.length) throw new Error("日粒度治理失败");
    const adjustments = range.monthly ? adjustmentRows(old.accounted, latest, range.openFrom, range.yearStart, revision) : [];
    return { range, revision, latest, events, daily, adjustments };
  }

  async function baselineReview(cutoff, proposal) {
    const daily = client(config.feishuDailyTableId);
    await ensureFields(daily, normalFields);
    const records = await daily.listRecords();
    const index = normalIndex(records.filter(r => recordDay(r.fields["日期"]) >= proposal.range.yearStart && recordDay(r.fields["日期"]) <= cutoff));
    const all = await transformDailyPlans(Object.values(proposal.latest).map(x => x.plan), jira, { includeAllocationIds: true });
    const desired = new Map(all.rows.map(row => [row.sourceKey, row]));
    const differences = [];
    for (const key of new Set([...index.keys(), ...desired.keys()])) {
      const existing = index.get(key), row = desired.get(key);
      const actual = existing ? Number(existing.fields[hoursField]) : null;
      const expected = row ? row.fields["工时"] : null;
      if (actual !== expected) differences.push({ key, existingHours: actual, jiraHours: expected });
    }
    return { hash: digest([proposal.latest, [...index].map(([key, r]) => [key, r.record_id, r.fields[hoursField]])]),
      differences, records: [...index].map(([key, record]) => ({ key, recordId: record.record_id })) };
  }

  async function preview(cutoff) {
    validateConfiguration();
    const state = await store();
    const old = state.data.assignment;
    if (old?.pending) return { pending: true, ...publicProposal(old.pending) };
    const proposal = await collect(cutoff, old);
    const review = old?.initialized ? undefined : await baselineReview(cutoff, proposal);
    return { initialized: Boolean(old?.initialized), ...publicProposal(proposal), baseline: review };
  }
  function publicProposal(p) {
    return { range: p.range, revision: p.revision, events: p.events.map(e => ({ id: e.id, key: e.key, type: e.type })),
      daily: p.daily, adjustments: p.adjustments };
  }

  async function initialize(cutoff, expectedHash) {
    return withSyncWriteGuard(config, async () => {
      validateConfiguration(); validateExecutionDate(cutoff);
      const state = await store();
      if (state.data.assignment?.initialized) throw new Error("已初始化，不允许覆盖历史基线");
      const proposal = await collect(cutoff);
      const review = await baselineReview(cutoff, proposal);
      if (review.differences.length) throw new Error(`历史基线有 ${review.differences.length} 项差异，请先核对 preview.baseline，不能将未知历史差异当作新增`);
      if (!expectedHash || expectedHash !== review.hash) throw new Error("基线确认摘要缺失或变化，请重新预览并传入 baselineHash");
      await ensureFields(client(config.feishuTableId), LOG_FIELDS, true);
      await ensureFields(client(templateId), BACKFILL_FIELDS, true);
      // Adopt the verified legacy rows by adding provenance only; never rewrite their hours.
      const provenance = await transformDailyPlans(Object.values(proposal.latest).map(x => x.plan), jira, { includeAllocationIds: true });
      const ids = new Map(review.records.map(row => [row.key, row.recordId]));
      await client(config.feishuDailyTableId).batchUpdate(provenance.rows.map(row => ({
        recordId: ids.get(row.sourceKey), fields: { "派工识别id": row.fields["派工识别id"] },
      })));
      const app = await client(config.feishuDailyTableId).resolveAppToken();
      const mapping = state.table(app, config.feishuDailyTableId);
      for (const row of review.records) mapping.records[row.key] = { recordId: row.recordId, day: JSON.parse(row.key)[0] };
      state.data.assignment = { initialized: true, initializedAt: now().toISOString(), baselineHash: review.hash,
        revision: 0, closedThrough: shiftDay(periodStart(cutoff), -1),
        observed: proposal.latest, accounted: proposal.latest, months: {}, pending: null };
      await state.save();
      return { initialized: true, baselineHash: review.hash, sourceDays: Object.keys(proposal.latest).length };
    });
  }

  async function monthTable(state, proposal) {
    const a = state.data.assignment;
    const month = proposal.range.runDate.slice(0, 7);
    let mapping = a.months[month];
    const template = client(templateId);
    if (!mapping) {
      const tables = await template.listTables();
      const shortName = `工时信息-补录-${Number(month.slice(5))}月`;
      const startYear = a.initializedAt.slice(0, 4);
      const name = month.startsWith(startYear) ? shortName : `工时信息-补录-${month.slice(0, 4)}年${Number(month.slice(5))}月`;
      const matches = tables.filter(t => t.name === name);
      if (matches.length > 1) throw new Error(`月表名称重复：${name}`);
      let id = matches[0]?.table_id;
      // Existing named table is reusable only if it is the explicitly configured template
      // or an interrupted creation recorded in state.
      if (id && id !== templateId) throw new Error(`未登记的同名月表 ${name}，请核对归属后恢复月份映射`);
      mapping = { name, tableId: id || null, ready: id === templateId };
      a.months[month] = mapping;
      await state.save();
    }
    if (!mapping.tableId) {
      const matches = (await template.listTables()).filter(t => t.name === mapping.name);
      if (matches.length > 1) throw new Error("创建月表恢复时发现重名表");
      const initialFields = [...(await template.listFields()).keys()].map(textField);
      mapping.tableId = matches[0]?.table_id || (await template.createTable(mapping.name, initialFields)).table_id;
      if (!mapping.tableId) throw new Error("创建月表未返回 table_id");
      await state.save();
    }
    const target = client(mapping.tableId);
    if (!mapping.ready) {
      await cloneSchema(template, target);
      mapping.ready = true;
      await state.save();
    }
    await ensureFields(target, BACKFILL_FIELDS, true);
    return target;
  }

  async function writeNormal(state, proposal) {
    const target = client(config.feishuDailyTableId);
    await ensureFields(target, normalFields);
    const remote = normalIndex(await target.listRecords());
    const app = await target.resolveAppToken();
    const mapping = state.table(app, config.feishuDailyTableId);
    const desired = new Set(proposal.daily.rows.map(row => row.sourceKey));
    const creates = [], updates = [];
    for (const row of proposal.daily.rows) {
      const { 工时: hours, ...rest } = row.fields;
      const fields = target.serializeFields({ ...rest, [hoursField]: hours });
      const existing = remote.get(row.sourceKey);
      if (existing) updates.push({ recordId: existing.record_id, fields });
      else creates.push({ fields });
    }
    if (updates.length) await target.batchUpdate(updates);
    if (creates.length) {
      const result = await target.batchCreate(creates);
      if (result.length !== creates.length) throw new Error("正常工时创建结果不完整");
    }
    const deletions = [];
    for (const [key, known] of Object.entries(mapping.records)) {
      if (known.day >= proposal.range.openFrom && known.day <= proposal.range.cutoff && !desired.has(key) && remote.has(key)) deletions.push(remote.get(key).record_id);
    }
    if (deletions.length) await target.batchDelete(deletions);
    const after = normalIndex(await target.listRecords());
    for (const row of proposal.daily.rows) {
      const record = after.get(row.sourceKey);
      if (!record || Number(record.fields[hoursField]) !== row.fields["工时"] || textValue(record.fields["派工识别id"]) !== row.fields["派工识别id"]) throw new Error("正常工时回读校验失败");
      mapping.records[row.sourceKey] = { recordId: record.record_id, day: row.sourceDay };
    }
    for (const [key, known] of Object.entries(mapping.records)) if (known.day >= proposal.range.openFrom && known.day <= proposal.range.cutoff && !desired.has(key)) {
      if (after.has(key)) throw new Error("正常工时删除回读校验失败");
      delete mapping.records[key];
    }
    await state.save();
    return { created: creates.length, updated: updates.length, deleted: deletions.length };
  }

  async function sync(cutoff) {
    return withSyncWriteGuard(config, async () => {
      validateConfiguration(); validateExecutionDate(cutoff);
      const state = await store();
      const a = state.data.assignment;
      if (!a?.initialized) throw new Error("新派工策略尚未初始化：先 preview 核对基线，再 initialize");
      const raw = client(config.feishuTableId);
      await ensureFields(raw, LOG_FIELDS);
      const fields = raw.fieldMap.get("派工状态");
      if (["新增", "修改", "删除"].some(name => !fields.property?.options?.some(o => o.name === name))) throw new Error("派工状态选项不完整");
      await ensureFields(client(config.feishuDailyTableId), normalFields);
      if (!a.pending) {
        a.pending = await collect(cutoff, a);
        await state.save(); // Durable outbox BEFORE the first remote business write.
      }
      const p = a.pending;
      const month = p.range.monthly ? await monthTable(state, p) : null;
      const logs = p.events.map(event => {
        const entry = event.after || event.before;
        return { key: event.id, fields: { ...entry.raw, allocationId: String(entry.plan.allocationId),
          "来源唯一键": event.key, "工时日期": entry.plan.day, "派工状态": event.type,
          "变更前工时": event.before?.daily.fields["工时"] || 0, "变更后工时": event.after?.daily.fields["工时"] || 0,
          dateCreated: entry.plan.dateCreated, dateUpdated: entry.plan.dateUpdated,
          "Sync batch ID": `${p.range.runDate}:${p.revision}` } };
      });
      const logged = await appendOnce(raw, logs, "变更事件ID");
      const normal = await writeNormal(state, p);
      const backfill = month ? await appendOnce(month, p.adjustments.map(row => ({ ...row,
        fields: { ...row.fields, "调整期间": p.range.runDate.slice(0, 7) } })), "同步明细键") : null;
      if (month) {
        await state.archiveAssignment(`${p.range.runDate.slice(0, 7)}-r${p.revision}`, {
          range: p.range, revision: p.revision, tableId: month.tableId,
          sourceSnapshot: p.latest, normalRows: p.daily.rows, adjustments: p.adjustments,
        });
      }
      a.observed = p.latest;
      a.accounted = replaceRange(a.accounted, Object.fromEntries(Object.entries(p.latest).filter(([, e]) =>
        e.plan.day >= (p.range.monthly ? p.range.yearStart : p.range.openFrom) && e.plan.day <= p.range.cutoff)),
      p.range.monthly ? p.range.yearStart : p.range.openFrom, p.range.cutoff);
      if (p.range.monthly) a.closedThrough = p.range.dueEnd;
      a.revision = p.revision;
      a.pending = null;
      await state.save();
      return { range: p.range, logged, normal, backfill, monthTableId: month?.tableId,
        resumedOlderRun: p.range.cutoff !== cutoff };
    });
  }
  return { preview, sync, initialize };
}
