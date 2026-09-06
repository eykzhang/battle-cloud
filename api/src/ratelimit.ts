import type { Store } from './store.ts';

/**
 * A fixed-window submission limiter, keyed by client address, counted in Postgres.
 *
 * Postgres rather than process memory because the limit has to hold across API
 * instances: an in-memory counter lets N instances enforce N times the configured limit,
 * and the deployment target autoscales. The counter is also the one piece of API state
 * that must survive a restart, since a limiter that forgets on deploy is a limiter an
 * attacker can reset.
 *
 * Windows are aligned to the wall clock (`floor(now / windowMs) * windowMs`) rather than
 * starting at a client's first request. Two instances have to agree on where a window
 * begins without talking to each other, and arithmetic on their own clocks is the
 * cheapest agreement available. The cost is that a client's allowance refills at a
 * boundary they do not choose, and that clock skew between instances shifts the boundary
 * by the skew. Both are acceptable for an hourly window sized to stop one address
 * queueing hundreds of core-minutes.
 *
 * Only job creation is limited. A cached read costs a query; a search costs a core-minute.
 */
export class RateLimiter {
  // Explicit fields rather than constructor parameter properties: Node's strip-only
  // TypeScript support cannot transform those, and the tests run .ts directly.
  private readonly store: Store;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private lastSweep: number;

  constructor(store: Store, limit: number, windowMs: number = 60 * 60 * 1000, now: () => number = Date.now) {
    this.store = store;
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.lastSweep = now();
  }

  private windowStart(at: number): Date {
    return new Date(Math.floor(at / this.windowMs) * this.windowMs);
  }

  /** True when the caller may proceed. Consumes one unit when it returns true. */
  async tryConsume(key: string): Promise<boolean> {
    const at = this.now();
    const allowed = await this.store.consumeRateLimit(key, this.windowStart(at), this.limit);
    await this.sweep(at);
    return allowed;
  }

  /**
   * Seconds until this client's window closes. Pure arithmetic on the aligned boundary,
   * so it costs no query: the answer does not depend on what the counter holds.
   */
  retryAfterSeconds(_key: string): number {
    const at = this.now();
    return Math.max(0, Math.ceil((this.windowStart(at).getTime() + this.windowMs - at) / 1000));
  }

  /**
   * At most once per window per instance. Deleting on every request would triple the
   * write cost of a submission to clean up rows that nothing reads.
   */
  private async sweep(at: number): Promise<void> {
    if (at - this.lastSweep < this.windowMs) return;
    this.lastSweep = at;
    await this.store.sweepRateLimits(this.windowStart(at));
  }
}
