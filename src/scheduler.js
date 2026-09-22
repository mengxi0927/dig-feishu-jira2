const DAY = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET = 8 * 60 * 60 * 1000;

// 固定北京时间，不受服务器操作系统时区影响。
export function nextAssignmentRun(now = new Date()) {
  const local = new Date(now.getTime() + SHANGHAI_OFFSET);
  let runAt = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 6)
    - SHANGHAI_OFFSET;
  if (runAt <= now.getTime()) runAt += DAY;
  return {
    runAt: new Date(runAt),
    date: new Date(runAt + SHANGHAI_OFFSET - DAY).toISOString().slice(0, 10),
  };
}

// 派工和报工共享状态文件，HTTP 请求与定时任务必须串行写入。
export function createSyncQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };
}

export function startAssignmentScheduler({
  sync,
  now = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console,
  label = "派工",
}) {
  let stopped = false;
  let timer;
  function schedule() {
    if (stopped) return;
    const current = now();
    const { runAt, date } = nextAssignmentRun(current);
    logger.log(`[${label}定时同步] 下次运行 ${runAt.toISOString()}（北京时间06:00），同步日期 ${date}`);
    timer = setTimer(async () => {
      try {
        logger.log(`[${label}定时同步] 开始同步 ${date}`);
        const result = await sync(date);
        logger.log(`[${label}定时同步] 完成 ${date} ${JSON.stringify(result)}`);
      } catch (error) {
        logger.error(`[${label}定时同步] 失败 ${date}: ${error.message}`);
      } finally {
        schedule();
      }
    }, runAt.getTime() - current.getTime());
  }
  schedule();
  return () => {
    stopped = true;
    clearTimer(timer);
  };
}

export function startWorklogScheduler(options) {
  const { sync } = options;
  return startAssignmentScheduler({ ...options, label: "报工", sync: (date) => sync(date, date) });
}
