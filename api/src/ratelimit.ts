/**
 * A fixed-window submission limiter, keyed by client address.
 *
 * In-memory on purpose, and that is a real limitation rather than an oversight: two API
 * instances each enforce their own window, so the effective limit is the configured one
 * times the instance count. It is sized to stop one address from queueing hundreds of
 * core-minutes, not to be a precise quota. Moving it to Postgres or Redis is the fix when
 * there is more than one instance, and it is the first thing that should change if the
 * service is ever public in earnest.
 *
 * Only job creation is limited. A cached read costs a query; a search costs a core-minute.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  // Explicit fields rather than constructor parameter properties: Node's strip-only
  // TypeScript support cannot transform those, and the tests run .ts directly.
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(limit: number, windowMs: number = 60 * 60 * 1000, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** True when the caller may proceed. Consumes one unit when it returns true. */
  tryConsume(key: string): boolean {
    const now = this.now();
    const entry = this.hits.get(key);
    if (entry === undefined || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      this.sweep(now);
      return true;
    }
    if (entry.count >= this.limit) return false;
    entry.count += 1;
    return true;
  }

  retryAfterSeconds(key: string): number {
    const entry = this.hits.get(key);
    if (entry === undefined) return 0;
    return Math.max(0, Math.ceil((entry.resetAt - this.now()) / 1000));
  }

  /**
   * Drop expired windows. Without this the map grows once per distinct address forever,
   * which is a slow memory leak that only shows up under the traffic pattern the limiter
   * exists for.
   */
  private sweep(now: number): void {
    if (this.hits.size < 1000) return;
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
  }
}
