import Fastify from 'fastify';
import pg from 'pg';
import { loadConfig, ConfigError } from './config.ts';
import { Store } from './store.ts';
import { RateLimiter } from './ratelimit.ts';
import { registerRoutes } from './routes.ts';
import { createWorkerLauncher } from './worker.ts';

export async function buildServer(deps?: Partial<Parameters<typeof registerRoutes>[1]>) {
  const config = deps?.config ?? loadConfig();
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const app = Fastify({
    logger: true,
    // Fastify trusts no proxy by default, so request.ip is the socket address. Behind a
    // load balancer this must become the forwarded address or every client shares one
    // rate-limit bucket. Left off until there is a proxy whose headers can be trusted:
    // trusting them without one lets any caller spoof their own identity.
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
