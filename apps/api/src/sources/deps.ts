import type { Env } from '../env.js';
import type { Deps, QueuedJob } from './discovery.js';

/** Real dependencies: global fetch and the Cloudflare queue. */
export function depsFor(env: Env): Deps {
  return {
    fetch: (input, init) => fetch(input, init),
    enqueue: async (jobs: QueuedJob[]) => {
      const msgs = jobs.map(({ delaySeconds, ...body }) => ({ body, ...(delaySeconds ? { delaySeconds: Math.min(delaySeconds, 43_200) } : {}) }));
      for (let i = 0; i < msgs.length; i += 100) await env.JOBS.sendBatch(msgs.slice(i, i + 100));
    },
  };
}
