import { createHash } from "node:crypto";
import { assignmentRecognitionId, transformDailyPlans, transformPlans } from "./transform.js";

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export const digest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export function day(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "") || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error("日期无效，应为 YYYY-MM-DD");
  return value;
}
export const shiftDay = (value, offset) => new Date(Date.parse(`${day(value)}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
export function periodStart(date) {
  day(date);
  const d = new Date(`${date}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (d.getUTCDate() < 22 ? 1 : 0), 22)).toISOString().slice(0, 10);
}

// Financial periods change at 00:00 Asia/Shanghai on the 22nd, independently of job success.
export function scheduleRange(cutoff, state) {
  day(cutoff);
  const runDate = shiftDay(cutoff, 1);
  const dueEnd = shiftDay(periodStart(runDate), -1);
  const monthly = Boolean(state?.initialized && state.closedThrough < dueEnd);
  const yearStart = `${cutoff.slice(0, 4)}-01-01`;
  const openFrom = periodStart(runDate);
  // Annual scope deliberately excludes prior-year backfills.
  const fullFrom = yearStart;
  const rollingFrom = [shiftDay(cutoff, -29), openFrom].sort()[0];
  return { cutoff, runDate, monthly, dueEnd, openFrom, yearStart, fullFrom,
    from: monthly || !state?.initialized ? fullFrom : [yearStart, rollingFrom].sort().at(-1) };
}

export async function snapshotPlans(plans, jira) {
  const snapshot = {};
  // Preserve existing raw mapping, while retaining the original daily contribution separately.
  const raw = new Map((await transformPlans(plans, jira)).map(row => [row.sourceKey, row.fields]));
  for (const plan of plans) {
    if (plan.allocationId == null || !String(plan.allocationId).trim()) throw new Error("派工缺少 allocationId，停止同步");
    const result = await transformDailyPlans([plan], jira, { includeAllocationIds: true });
    if (result.errors.length || result.rows.length !== 1) throw new Error(`派工 ${plan.allocationId} 日明细无效`);
    const key = `${plan.allocationId}|${plan.day}`;
    const entry = { plan, daily: result.rows[0], raw: raw.get(key) };
    if (snapshot[key] && digest(snapshot[key]) !== digest(entry)) throw new Error(`同一来源键返回不同内容：${key}`);
    snapshot[key] = entry;
  }
  return snapshot;
}

export function replaceRange(previous, current, from, to) {
  const next = { ...previous };
  for (const [key, entry] of Object.entries(next)) if (entry.plan.day >= from && entry.plan.day <= to) delete next[key];
  return { ...next, ...current };
}

export function changes(previous, current, revision) {
  const events = [];
  for (const key of [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort()) {
    const before = previous[key], after = current[key];
    if (digest(before ?? null) === digest(after ?? null)) continue;
    events.push({ id: digest([revision, key, before ?? null, after ?? null]), key, before, after,
      type: !before ? "新增" : !after ? "删除" : "修改" });
  }
  return events;
}

// This is when the allocation was entered in Jira, not its work date or sync time.
export function allocationEntryDay(plan) {
  const value = plan?.dateCreated;
  if (value == null || value === "") return undefined;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    try { return day(value); } catch { return undefined; }
  }
  // Only timestamps with an explicit timezone are unambiguous.
  if (typeof value !== "number" && !(typeof value === "string" && /T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(value))) return undefined;
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  const date = new Date(timestamp + 8 * 3600000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

// Historical baseline routing is based on entry time, not the date of this audit.
// Earlier planning for a future work period is allowed; only entry after close is late.
export function classifyHistoricalPlans(plans, year) {
  const normal = [], late = [], modifiedAfterClose = [];
  for (const plan of plans) {
    day(plan.day);
    if (!plan.day.startsWith(`${year}-`)) continue;
    const entered = allocationEntryDay(plan);
    if (!entered) throw new Error(`派工 ${plan.allocationId} 缺少有效创建日期，不能自动归类`);
    if (plan.day < periodStart(entered)) late.push(plan);
    else {
      normal.push(plan);
      const updated = allocationEntryDay({ dateCreated: plan.dateUpdated });
      if (updated && plan.day < periodStart(updated)) modifiedAfterClose.push(plan);
    }
  }
  return { normal, late, modifiedAfterClose };
}

// Delta per source/day and destination: moving project/person/date produces two legs.
export function adjustmentRows(accounted, latest, beforeDay, yearStart, revision) {
  const rows = [];
  const keys = [...new Set([...Object.keys(accounted), ...Object.keys(latest)])].sort();
  for (const key of keys) {
    const old = accounted[key], fresh = latest[key];
    const date = (fresh || old).plan.day;
    if (date < yearStart || date >= beforeDay) continue;
    const legs = new Map();
    for (const [entry, sign] of [[old, -1], [fresh, 1]]) {
      if (!entry) continue;
      const group = entry.daily.sourceKey;
      const item = legs.get(group) || { fields: entry.daily.fields, seconds: 0 };
      item.seconds += sign * Number(entry.plan.timePlannedSeconds ?? entry.plan.secondsPerDay);
      legs.set(group, item);
    }
    for (const [group, leg] of legs) {
      if (Math.abs(leg.seconds) < 1e-8) continue;
      rows.push({ key: digest([revision, key, group, old?.daily ?? null, fresh?.daily ?? null]), fields: {
        "项目号": leg.fields["项目号"], "姓名": leg.fields["姓名"], "日期": date,
        "派工识别id": assignmentRecognitionId((fresh || old).plan.allocationId, date),
        "补录工时（小时）": Math.round(leg.seconds / 3600 * 10000) / 10000,
        ...(allocationEntryDay((fresh || old).plan) ? { "派工录入日期": allocationEntryDay((fresh || old).plan) } : {}),
      } });
    }
  }
  return rows;
}
