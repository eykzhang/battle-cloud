import Fastify from 'fastify';
import pg from 'pg';
import { loadConfig, ConfigError } from './config.ts';
import { Store } from './store.ts';
import { RateLimiter } from './ratelimit.ts';
import { registerRoutes } from './routes.ts';
import { createWorkerLauncher } from './worker.ts';

export async function buildServer(deps?: Partial<Parameters<typeof registerRoutes>[1]>) {
  const config = deps?.config ?? loadConfig();
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax });
  const app = Fastify({
    logger: true,
    // Off, and correct behind API Gateway as well as in front of it. The Lambda adapter
    // injects `requestContext.http.sourceIp` as the request's remote address, so
    // `request.ip` is already the address AWS observed at the edge, which a caller cannot
    // forge. Turning trustProxy on would replace that with the leftmost X-Forwarded-For
    // entry, which a caller writes: strictly worse. `test/lambda.test.ts` pins this,
    // because it is a property of the adapter rather than of anything in this file.
    trustProxy: false,
  });
  const store = deps?.store ?? new Store(pool);
  await registerRoutes(app, {
    config,
    store,
    limiter: deps?.limiter ?? new RateLimiter(store, config.submitRateLimitPerHour),
    fetch: deps?.fetch ?? globalThis.fetch,
    launcher: deps?.launcher ?? createWorkerLauncher(config.workerLaunch, app.log),
  });
  app.addHook('onClose', async () => {
    await pool.end();
  });
  return { app, config };
}

async function main(): Promise<void> {
  try {
    const { app, config } = await buildServer();
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (cause) {
    if (cause instanceof ConfigError) {
      console.error(`configuration error: ${cause.message}`);
      process.exit(2);
    }
    console.error(cause);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
