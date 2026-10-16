// Central per-provider rate-limit controller: RPM sliding window, bounded concurrency,
// Retry-After cool-downs and a simple health circuit breaker. Pure (clock injectable), tested.
// Note: state is per Worker isolate; it smooths bursts but is not a global quota guarantee.

export type LimitConfig = { rpm: number; concurrency: number };

export const PROVIDER_LIMITS: Record<string, LimitConfig> = {
  nvidia: { rpm: 40, concurrency: 4 },
  groq: { rpm: 30, concurrency: 4 },
  cf: { rpm: 300, concurrency: 4 }, // Workers AI text-generation default is 300 req/min per account
};

type Waiter = () => void;
type State = { stamps: number[]; active: number; queue: Waiter[]; coolUntil: number; failures: number; openUntil: number };

export class RateLimiter {
  private s = new Map<string, State>();
  constructor(private limits: Record<string, LimitConfig> = PROVIDER_LIMITS, private now: () => number = Date.now, private maxWaitMs = 20_000) {}

  private st(key: string): State {
    let v = this.s.get(key);
    if (!v) { v = { stamps: [], active: 0, queue: [], coolUntil: 0, failures: 0, openUntil: 0 }; this.s.set(key, v); }
    return v;
  }

  /** True when the provider is healthy enough to try (circuit closed, not cooling down beyond maxWait). */
  available(key: string): boolean {
    const v = this.st(key), t = this.now();
    return v.openUntil <= t && v.coolUntil - t <= this.maxWaitMs;
  }

  /** Milliseconds until a new request may start (0 = now). */
  delayFor(key: string): number {
    const v = this.st(key), t = this.now(), lim = this.limits[key] ?? { rpm: 60, concurrency: 2 };
    v.stamps = v.stamps.filter((x) => t - x < 60_000);
    let d = Math.max(0, v.coolUntil - t);
    if (v.stamps.length >= lim.rpm) d = Math.max(d, 60_000 - (t - v.stamps[0]));
    return d;
  }

  /** Waits for a concurrency slot and RPM capacity. Throws if it would exceed maxWaitMs. Returns release(). */
  async acquire(key: string, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<() => void> {
    const v = this.st(key), lim = this.limits[key] ?? { rpm: 60, concurrency: 2 };
    const start = this.now();
    if (v.active >= lim.concurrency) await new Promise<void>((r) => v.queue.push(r));
    v.active++;
    let d: number;
    while ((d = this.delayFor(key)) > 0) {
      if (this.now() - start + d > this.maxWaitMs) { this.release(key); throw new Error(`rate limit: ${key} busy`); }
      await sleep(d);
    }
    v.stamps.push(this.now());
    let done = false;
    return () => { if (!done) { done = true; this.release(key); } };
  }

  private release(key: string) {
    const v = this.st(key);
    v.active = Math.max(0, v.active - 1);
    v.queue.shift()?.();
  }

  /** Records a provider outcome: 429 sets a cool-down (Retry-After), repeated 5xx/timeouts open the circuit. */
  report(key: string, status: number, retryAfter?: string | null) {
    const v = this.st(key), t = this.now();
    if (status === 429) {
      const sec = Number(retryAfter);
      v.coolUntil = t + (Number.isFinite(sec) && sec > 0 ? Math.min(sec, 120) * 1000 : 10_000);
      return;
    }
    if (status >= 500 || status === 504) {
      v.failures++;
      if (v.failures >= 3) { v.openUntil = t + 30_000; v.failures = 0; }
      return;
    }
    if (status >= 200 && status < 300) v.failures = 0;
  }

  snapshot(key: string) {
    const v = this.st(key);
    return { active: v.active, queued: v.queue.length, lastMinute: v.stamps.filter((x) => this.now() - x < 60_000).length, coolingMs: Math.max(0, v.coolUntil - this.now()), open: v.openUntil > this.now() };
  }
}

export const limiter = new RateLimiter();
