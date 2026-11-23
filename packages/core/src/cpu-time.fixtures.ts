/**
 * Time limits in tests, measured in CPU time (U-003).
 *
 * The tests that guard against quadratic or catastrophic blowups used to
 * time themselves on the wall clock, which also counts the time the test
 * waits while other processes use the CPU: on a busy 2-CPU machine (the
 * gate's other test files, other builds) the same work took two to three
 * times as long and the tests failed. `cpuClock` measures only the CPU time
 * this thread spent running the work, which other processes can't add to,
 * so the limits stay exactly as tight as they were: a quadratic version of
 * the code uses as much more CPU as it used to take wall time, and fails.
 *
 * Every such test keeps its limit as a CPU-time assertion, and its vitest
 * `timeout` (which is wall clock) becomes a hang guard only: `hangGuard`
 * leaves room for a machine several times busier than this one.
 */

interface Usage {
  user: number;
  system: number;
}

/** This thread's CPU time so far, in microseconds. */
function usage(): Usage {
  // `process.threadCpuUsage` (newer Node releases) leaves out other
  // threads, such as the garbage collector's helpers. Where it is missing,
  // the whole process is counted, which only ever counts more, never less.
  const thread = (process as { threadCpuUsage?: () => Usage }).threadCpuUsage;
  return typeof thread === "function" ? thread.call(process) : process.cpuUsage();
}

/**
 * Start a CPU-time stopwatch: the function returned gives the CPU
 * milliseconds this thread has used since.
 */
export function cpuClock(): () => number {
  const start = usage();
  return () => {
    const now = usage();
    return (now.user - start.user + now.system - start.system) / 1000;
  };
}

/**
 * Test options for a test whose limit is `limitMs` of CPU time: a wall-clock
 * timeout that only stops a hang, at four times the limit and at least a
 * minute.
 */
export function hangGuard(limitMs: number): { timeout: number } {
  return { timeout: Math.max(60_000, limitMs * 4) };
}
