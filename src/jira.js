import { requestJson } from "./http.js";

export class JiraClient {
  constructor({ baseUrl, username, password }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    this.userCache = new Map();
    this.projectCache = null;
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
