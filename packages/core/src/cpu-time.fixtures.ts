/**
 * Time limits in tests, measured in CPU time (U-003).
 *
 * The tests that guard against quadratic or catastrophic blowups used to
 * time themselves on the wall clock, which also counts the time the test
 * waits while other processes use the CPU: on a busy 2-CPU machine (the
 * gate's other test files, other builds) the same work took two to three
 * times as long and the tests failed. `cpuClock` measures the CPU time this
 * process spent (`process.cpuUsage`), which other processes can't add to.
 * Vitest runs each test file in its own process, so other test files don't
 * count either. The whole process is counted, not just the main thread, so
 * the garbage collector's helper threads count too: on an idle machine this
 * matches the old wall-clock reading within a few percent, so the limits stay
 * as tight as they were, including for blowups that are mostly garbage
 * collection (the U-003 review measured the main thread alone at 25-70% less).
 *
 * Every such test keeps its limit as a CPU-time assertion, and its vitest
 * `timeout` (which is wall clock) becomes a hang guard only: `hangGuard`
 * leaves room for a machine several times busier than this one.
 */

interface Usage {
  user: number;
  system: number;
}

/** This process's CPU time so far (every thread), in microseconds. */
function usage(): Usage {
  return process.cpuUsage();
}

/**
 * Start a CPU-time stopwatch: the function returned gives the CPU
 * milliseconds this process has used since.
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
 * timeout that only stops a hang, at three times the limit and at least
 * 30 seconds.
 */
export function hangGuard(limitMs: number): { timeout: number } {
  return { timeout: Math.max(30_000, limitMs * 3) };
}
