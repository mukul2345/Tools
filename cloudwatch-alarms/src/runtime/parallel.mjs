/**
 * Bounded concurrency: run async tasks with a fixed pool size.
 * @param {Array<() => Promise<any>>} tasks - Array of functions that return promises
 * @param {number} concurrency - Max concurrent executions (default 8)
 * @returns {Promise<any[]>} - Results in same order as tasks
 */
export async function runWithConcurrency(tasks, concurrency = 8) {
  const results = new Array(tasks.length);
  let index = 0;

  async function runNext() {
    if (index >= tasks.length) return;
    const i = index++;
    const task = tasks[i];
    const r = await Promise.resolve().then(() => task());
    results[i] = r;
    if (index < tasks.length) await runNext();
  }

  const workers = Array(Math.min(concurrency, tasks.length))
    .fill(null)
    .map(() => runNext());
  await Promise.all(workers);
  return results;
}
