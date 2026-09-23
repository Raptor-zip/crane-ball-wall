// Worker entry: /api/* router and cron (GAME_DESIGN.md §7.7, §10.5). Owner: O9.
// Static assets never reach this code (assets.run_worker_first = ["/api/*"]), so they cost no Worker requests.
import { handleBoot } from './routes/boot';
import { handleSubmit } from './routes/submit';
import { handleBoard } from './routes/board';
import { handleGhost } from './routes/ghost';
import { handleBench } from './routes/bench';
import { runCron } from './cron';
import { warmup } from './warmup';
import { Db, apiError } from './db';
import { counterFlushDue, flushCounters, noteRequest, nowMs } from './limits';

/** Bindings and vars of wrangler.jsonc. */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  RL_SUBMIT?: RateLimit;   // may be unavailable; limits.ts falls back to an in-memory token bucket
  RL_READ?: RateLimit;
  DEV: string;             // "1" enables /api/bench
  READ_ONLY: string;       // "1" stops all writes (503)
}

declare global {
  namespace Cloudflare {
    // Makes `env` from "cloudflare:workers" / "cloudflare:test" typed.
    interface Env extends WorkerEnv {}
  }
}
type WorkerEnv = Env;

// Module-scope JIT warm-up (§7.8); counts towards startup time, not request CPU.
warmup();

type Handler = (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

function route(p: string): Handler | null {
  if (p === '/api/boot') return handleBoot;
  if (p === '/api/submit') return handleSubmit;
  if (p.startsWith('/api/board/')) return handleBoard;
  if (p.startsWith('/api/ghost/')) return handleGhost;
  if (p === '/api/bench') return handleBench;
  return null;
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const p = new URL(req.url).pathname;
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);
    const now = nowMs();
    noteRequest(now);
    let res: Response;
    const h = route(p);
    if (!h) {
      res = apiError(404, 'notFound');
    } else {
      try {
        res = await h(req, env, ctx);
      } catch (e) {
        console.error(JSON.stringify({ evt: 'error', path: p, err: String(e), stack: e instanceof Error ? e.stack : undefined }));
        res = apiError(500, 'internal');
      }
    }
    // §7.8 step 9: a processed /api/submit (200) has already flushed inline, inside its statement budget. Everything
    // else flushes after responding, including submits that ended early (400 / 403 / 413 / 415 / 429 / 503 / 500):
    // they used no statement or stopped within the budget, and a flood of them must still reach the request estimate.
    if ((p !== '/api/submit' || res.status !== 200) && counterFlushDue(now)) ctx.waitUntil(flushCounters(new Db(env.DB), env, now));
    return res;
  },
  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(runCron(env, controller.scheduledTime).then(
      () => undefined,
      (e: unknown) => console.error(JSON.stringify({ evt: 'cron-failed', err: String(e) })),
    ));
  },
} satisfies ExportedHandler<Env>;
