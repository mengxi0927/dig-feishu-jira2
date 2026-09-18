import { requestJson } from "./http.js";

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), Math.max(1, items.length)) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function worklogDay(worklog) {
  const started = String(worklog?.started || "");
  const match = started.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

export class JiraClient {
  constructor({ baseUrl, username, password }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    this.userCache = new Map();
    this.projectCache = null;
    this.fieldCache = null;
  }

  async request(pathname, options = {}) {
    return requestJson(`${this.baseUrl}${pathname}`, {
      ...options,
      headers: {
        Authorization: this.authorization,
        ...(options.headers || {}),
      },
    });
  }

  async fetchPlansRange(from, to, filters = {}) {
    const plans = await this.request("/rest/tempo-planning/1/plan/search", {
      method: "POST",
      body: JSON.stringify({ from, to, ...filters }),
      timeoutMs: 60000,
    });
    if (!Array.isArray(plans)) throw new Error("Tempo Planning 返回值不是数组");
    return plans;
  }

  async fetchPlans(date) {
    return this.fetchPlansRange(date, date);
  }

  async getFields() {
    if (this.fieldCache) return this.fieldCache;
    const fields = await this.request("/rest/api/2/field");
    this.fieldCache = Array.isArray(fields) ? fields : [];
    return this.fieldCache;
  }

  async searchIssues(jql, fields, pageSize = 100) {
    const issues = [];
    let startAt = 0;
    let total = 0;
    do {
      const query = new URLSearchParams({
        jql,
        startAt: String(startAt),
        maxResults: String(pageSize),
        fields: fields.join(","),
      });
      const response = await this.request(`/rest/api/2/search?${query.toString()}`, {
        timeoutMs: 60000,
      });
      const batch = Array.isArray(response?.issues) ? response.issues : [];
      total = Number(response?.total) || batch.length;
      issues.push(...batch);
      if (!batch.length) break;
      startAt += batch.length;
    } while (startAt < total);
    return { issues, total };
  }

  async fetchIssueWorklogs(issueKey, pageSize = 100) {
    const worklogs = [];
    let startAt = 0;
    let total = 0;
    do {
      const query = new URLSearchParams({
        startAt: String(startAt),
        maxResults: String(pageSize),
      });
      const response = await this.request(
        `/rest/api/2/issue/${encodeURIComponent(issueKey)}/worklog?${query.toString()}`,
        { timeoutMs: 60000 },
      );
      const batch = Array.isArray(response?.worklogs) ? response.worklogs : [];
      total = Number(response?.total) || batch.length;
      worklogs.push(...batch);
      if (!batch.length) break;
      startAt += batch.length;
    } while (startAt < total);
    return worklogs;
  }

  async fetchWorklogsRange(from, to, options = {}) {
    const allFields = await this.getFields();
    const epicLinkField = allFields.find((field) => field.name === "Epic Link")?.id || "";
    const epicNameField = allFields.find((field) => field.name === "Epic Name")?.id || "";
    const requestedFields = [
      "summary",
      "project",
      "issuetype",
      "status",
      "parent",
      "reporter",
      "components",
      "fixVersions",
      "timetracking",
      "timeoriginalestimate",
      "timeestimate",
      "worklog",
      epicLinkField,
      epicNameField,
    ].filter(Boolean);
    const rangeJql = `worklogDate >= ${from} AND worklogDate <= ${to}`;
    const jql = options.extraJql ? `(${rangeJql}) AND (${options.extraJql})` : rangeJql;
    const search = await this.searchIssues(jql, requestedFields, options.pageSize || 100);
    const issueWorklogs = await mapWithConcurrency(
      search.issues,
      options.concurrency || 6,
      async (issue) => {
        const embedded = issue.fields?.worklog || {};
        const embeddedRows = Array.isArray(embedded.worklogs) ? embedded.worklogs : [];
        const total = Number(embedded.total) || embeddedRows.length;
        if (embeddedRows.length >= total) return embeddedRows;
        return this.fetchIssueWorklogs(issue.key, options.pageSize || 100);
      },
    );

    const records = [];
    for (let index = 0; index < search.issues.length; index += 1) {
      const issue = search.issues[index];
      for (const worklog of issueWorklogs[index]) {
        const day = worklogDay(worklog);
        if (day >= from && day <= to) records.push({ issue, worklog });
      }
    }

    return {
      issues: search.issues,
      records,
      epicLinkField,
      epicNameField,
      jql,
    };
  }

  async fetchPlanAllocationsForDate(date) {
    const dailyPlans = await this.fetchPlans(date);
    if (!dailyPlans.length) return [];

    const starts = dailyPlans.map((plan) => plan.planStart || date).sort();
    const ends = dailyPlans.map((plan) => plan.planEnd || date).sort();
    const from = starts[0];
    const to = ends[ends.length - 1];
    const taskKey = [...new Set(dailyPlans.map((plan) => plan.planItemInfo?.key).filter(Boolean))];
    const filters = taskKey.length ? { taskKey } : {};
    const spanPlans = from === date && to === date
      ? dailyPlans
      : await this.fetchPlansRange(from, to, filters);

    const targetIds = new Set(dailyPlans.map((plan) => String(plan.allocationId)));
    const rowsByAllocation = new Map();
    for (const plan of spanPlans) {
      const allocationId = String(plan.allocationId);
      if (!targetIds.has(allocationId)) continue;
      const perDay = rowsByAllocation.get(allocationId) || new Map();
      perDay.set(plan.day, plan);
      rowsByAllocation.set(allocationId, perDay);
    }

    return dailyPlans.map((plan) => {
      const perDay = rowsByAllocation.get(String(plan.allocationId)) || new Map([[plan.day, plan]]);
      const planDays = [...perDay.values()];
      return {
        ...plan,
        _plannedDayCount: planDays.length,
        _plannedSecondsTotal: planDays.reduce(
          (total, item) => total + (Number(item.timePlannedSeconds) || 0),
          0,
        ),
      };
    });
  }

  async getProjectNames() {
    if (this.projectCache) return this.projectCache;
    const projects = await this.request("/rest/api/2/project");
    this.projectCache = new Map(
      (Array.isArray(projects) ? projects : []).map((project) => [project.key, project.name || project.key]),
    );
    return this.projectCache;
  }

  async getUserDisplayName(accountId) {
    if (!accountId) return "";
    if (this.userCache.has(accountId)) return this.userCache.get(accountId);
    let displayName = accountId;
    try {
      const user = await this.request(`/rest/api/2/user?username=${encodeURIComponent(accountId)}`);
      displayName = user?.displayName || user?.name || accountId;
    } catch (firstError) {
      try {
        const user = await this.request(`/rest/api/2/user?key=${encodeURIComponent(accountId)}`);
        displayName = user?.displayName || user?.name || accountId;
      } catch {
        displayName = accountId;
      }
    }
    this.userCache.set(accountId, displayName);
    return displayName;
  }
}
