import awsLambdaFastify from '@fastify/aws-lambda';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { buildServer } from './server.ts';

/**
 * The API as a Lambda function, behind an API Gateway HTTP API.
 *
 * Why this rather than the container image the Dockerfile builds: App Runner, the original
 * target, refuses this account with SubscriptionRequiredException in every region, from an
 * admin principal, with a verified payment method, while every other service accepts the
 * same credentials (2026-09-10). Lambda is also the cheaper shape for traffic measured in
 * submissions per day -- about $0.07 per thousand analyses served, against a few dollars a
 * month for anything that idles. See notes/decision-lambda-over-app-runner.md.
 *
 * The server is built once per instance rather than once per invocation, which is the
 * whole reason a warm Lambda is cheap here: the Fastify instance, the route table, and
 * above all the Postgres pool survive between requests, so a warm invocation costs a query
 * instead of a TLS handshake to Neon.
 */

/** The slice of the SSM client used here, so a test needs no AWS SDK behavior. */
export interface ParameterReader {
  send(command: GetParameterCommand): Promise<{ Parameter?: { Value?: string } }>;
}

/**
 * Puts the connection string in the environment `loadConfig` reads.
 *
 * Lambda has no equivalent of the ECS agent's secret injection, so the choice is between
 * a plaintext environment variable in the function's configuration and a read at cold
 * start. This is the read. It costs one API call per instance and keeps the value out of
 * both Terraform state and `GetFunctionConfiguration`, which is the same stance secrets.tf
 * already takes for the worker.
 *
 * A `DATABASE_URL` already in the environment wins, so compose and the test suite reach
 * none of this.
 */
export async function resolveDatabaseUrl(
  env: NodeJS.ProcessEnv,
  ssm: ParameterReader = new SSMClient({}),
): Promise<void> {
  if ((env['DATABASE_URL'] ?? '') !== '') return;
  const name = env['DATABASE_URL_PARAMETER'] ?? '';
  // Not an error: leaving both unset is a misconfiguration, and loadConfig already refuses
  // it with a message about the variable a reader will actually look for.
  if (name === '') return;

  const result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = result.Parameter?.Value ?? '';
  if (value === '') {
    throw new Error(`SSM parameter ${name} is empty; the connection string was never written to it`);
  }
  env['DATABASE_URL'] = value;
}

const ready = resolveDatabaseUrl(process.env)
  .then(() => buildServer())
  .then(({ app }) =>
    awsLambdaFastify(app, {
      // The pool keeps sockets open between invocations by design, and those keep the
      // event loop non-empty. Waiting for it to drain would bill the idle timeout on every
      // request and close the connections this shape exists to reuse.
      callbackWaitsForEmptyEventLoop: false,
    }),
  );

// `ready` is awaited in the handler, but its rejection would be unhandled until the first
// invocation arrives, and Node kills the process on an unhandled rejection. A cold start
// that cannot read its configuration should fail an invocation with the real error rather
// than take the instance down before one is delivered.
ready.catch(() => {});

export async function handler(event: APIGatewayProxyEventV2, context: Context) {
  const proxy = await ready;
  return proxy(event, context);
}
