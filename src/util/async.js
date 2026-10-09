export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with full jitter, capped. attempt starts at 1. */
export function backoffDelay(attempt, { baseMs = 1000, maxMs = 30000, random = Math.random } = {}) {
  const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}

/** Small FIFO semaphore limiting concurrent async work. */
export class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }

  async run(fn) {
    if (this.active >= this.max) {
      await new Promise((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

/** Runs fn over items with at most `limit` in flight; preserves order of results. */
export async function mapLimit(items, limit, fn) {
  const sem = new Semaphore(limit);
  return Promise.all(items.map((item, i) => sem.run(() => fn(item, i))));
}
