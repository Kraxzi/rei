import type { Env } from '../env.js';
import type { Deps, Job } from './discovery.js';

/** Real dependencies: global fetch and the Cloudflare queue. */
export function depsFor(env: Env): Deps {
  return {
    fetch: (input, init) => fetch(input, init),
    enqueue: async (jobs: Job[]) => {
      for (let i = 0; i < jobs.length; i += 100) await env.JOBS.sendBatch(jobs.slice(i, i + 100).map((body) => ({ body })));
    },
  };
}
