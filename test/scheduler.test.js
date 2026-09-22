import test from "node:test";
import assert from "node:assert/strict";
import { createSyncQueue, nextAssignmentRun, startAssignmentScheduler, startWorklogScheduler } from "../src/scheduler.js";

test("worklog runs the previous day at Shanghai 06:00 even when assignment fails", async () => {
  let current = new Date("2026-09-21T21:00:00Z");
  const callbacks = [];
  const events = [];
  const enqueue = createSyncQueue();
  const options = {
    now: () => current,
    setTimer: (callback, delay) => { callbacks.push(callback); assert.ok(delay > 0); },
    clearTimer() {},
    logger: { log() {}, error() {} },
  };
  const stopAssignment = startAssignmentScheduler({ ...options, sync: (date) => enqueue(async () => {
    events.push(["assignment", date]); throw new Error("assignment failure");
  }) });
  const stopWorklog = startWorklogScheduler({ ...options, sync: (from, to) => enqueue(async () => {
    events.push(["worklog", from, to]);
  }) });
  current = new Date("2026-09-21T22:00:00Z");
  await Promise.all(callbacks.slice().map((callback) => callback()));
  assert.deepEqual(events, [["assignment", "2026-09-21"], ["worklog", "2026-09-21", "2026-09-21"]]);
  assert.equal(callbacks.length, 4);
  stopAssignment(); stopWorklog();
});

test("schedules Shanghai 06:00 and the previous calendar date across year and leap-day boundaries", () => {
  for (const [current, expectedRun, expectedDate] of [
    ["2026-12-31T17:00:00Z", "2026-12-31T22:00:00.000Z", "2026-12-31"],
    ["2028-02-29T21:59:59Z", "2028-02-29T22:00:00.000Z", "2028-02-29"],
    ["2026-09-19T22:00:00Z", "2026-09-20T22:00:00.000Z", "2026-09-20"],
    ["2026-09-20T14:00:00Z", "2026-09-20T22:00:00.000Z", "2026-09-20"],
  ]) {
    const result = nextAssignmentRun(new Date(current));
    assert.equal(result.runAt.toISOString(), expectedRun);
    assert.equal(result.date, expectedDate);
  }
});

test("runs only when due, survives failure, and stops future scheduling", async () => {
  let current = new Date("2026-09-19T21:00:00Z");
  const timers = [];
  const dates = [];
  const errors = [];
  const cleared = [];
  const stop = startAssignmentScheduler({
    now: () => current,
    setTimer: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimer: (id) => cleared.push(id),
    logger: { log() {}, error: (message) => errors.push(message) },
    sync: async (date) => {
      dates.push(date);
      if (dates.length === 1) throw new Error("network unavailable");
      return { created: 1 };
    },
  });
  assert.deepEqual(dates, []);
  assert.equal(timers[0].delay, 3600000);
  current = new Date("2026-09-19T22:00:00Z");
  await timers[0].callback();
  assert.deepEqual(dates, ["2026-09-19"]);
  assert.match(errors[0], /network unavailable/);
  assert.equal(timers[1].delay, 86400000);
  current = new Date("2026-09-20T22:00:00Z");
  await timers[1].callback();
  assert.deepEqual(dates, ["2026-09-19", "2026-09-20"]);
  stop();
  assert.deepEqual(cleared, [3]);
});

test("serializes shared-state writes and accepts new work after a failed sync", async () => {
  const enqueue = createSyncQueue();
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = enqueue(async () => {
    events.push("first start");
    await gate;
    events.push("first end");
    throw new Error("failed");
  });
  const rejected = assert.rejects(first, /failed/);
  const second = enqueue(async () => { events.push("second"); return 42; });
  await Promise.resolve();
  assert.deepEqual(events, ["first start"]);
  release();
  await rejected;
  assert.equal(await second, 42);
  assert.deepEqual(events, ["first start", "first end", "second"]);
});
