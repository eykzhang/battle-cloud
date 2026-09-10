import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import awsLambdaFastify from '@fastify/aws-lambda';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';

/**
 * The rate limit is keyed by `request.ip`, and under Lambda that value comes from the
 * adapter rather than from anything in this repository: it injects
 * `requestContext.http.sourceIp` as the request's remote address. These tests exist
 * because that is a property of a dependency, so an upgrade could silently turn every
 * caller into one shared rate-limit bucket, or worse, into a spoofable one.
 */

const SOURCE_IP = '203.0.113.7';

function requestEvent(headers: Record<string, string> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/whoami',
    rawQueryString: '',
    headers: { host: 'api.example.com', ...headers },
    requestContext: {
      accountId: '618426070248',
      apiId: 'abc123',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'GET',
        path: '/whoami',
        protocol: 'HTTP/1.1',
        sourceIp: SOURCE_IP,
        userAgent: 'node:test',
      },
      requestId: 'id',
      routeKey: '$default',
      stage: '$default',
      time: '10/Sep/2026:00:00:00 +0000',
      timeEpoch: 1_788_000_000_000,
    },
    isBase64Encoded: false,
  } as APIGatewayProxyEventV2;
}

const CONTEXT = { callbackWaitsForEmptyEventLoop: true } as unknown as Context;

async function ipSeenBy(headers?: Record<string, string>): Promise<string> {
  const app = Fastify();
  app.get('/whoami', async (request) => ({ ip: request.ip }));
  const proxy = awsLambdaFastify(app, { callbackWaitsForEmptyEventLoop: false });
  const response = await proxy(requestEvent(headers), CONTEXT);
  await app.close();
  return JSON.parse(response.body).ip;
}

test('the address the rate limiter charges is the one API Gateway observed', async () => {
  assert.equal(await ipSeenBy(), SOURCE_IP);
});

test('a forwarded header the caller sent does not replace it', async () => {
  // The whole point of keying on sourceIp: if this ever returned 198.51.100.9, every
  // caller could pick their own bucket by sending one header, and the limit would be
  // decoration.
  assert.equal(await ipSeenBy({ 'x-forwarded-for': '198.51.100.9' }), SOURCE_IP);
});

test('the adapter leaves callbackWaitsForEmptyEventLoop off, so a warm pool is not drained', async () => {
  const app = Fastify();
  app.get('/whoami', async () => ({ ok: true }));
  const proxy = awsLambdaFastify(app, { callbackWaitsForEmptyEventLoop: false });
  const context = { callbackWaitsForEmptyEventLoop: true } as unknown as Context;
  await proxy(requestEvent(), context);
  await app.close();
  assert.equal(context.callbackWaitsForEmptyEventLoop, false);
});

/**
 * The cold-start read of the connection string. These are cheap tests for a step whose
 * failure mode is expensive: it runs once per instance, before anything else, and a
 * mistake here is a function that cannot serve a single request.
 */
import { resolveDatabaseUrl, type ParameterReader } from '../src/lambda.ts';

const NEVER_CALLED: ParameterReader = {
  async send() {
    throw new Error('SSM should not have been consulted');
  },
};

test('an environment that already carries the connection string is left alone', async () => {
  const env = { DATABASE_URL: 'postgres:///local', DATABASE_URL_PARAMETER: '/battle-cloud/database-url/api' };
  await resolveDatabaseUrl(env, NEVER_CALLED);
  assert.equal(env.DATABASE_URL, 'postgres:///local');
});

test('the parameter is read when only its name is configured', async () => {
  const env: NodeJS.ProcessEnv = { DATABASE_URL_PARAMETER: '/battle-cloud/database-url/api' };
  const reader: ParameterReader = {
    async send(command) {
      assert.equal(command.input.Name, '/battle-cloud/database-url/api');
      // Without decryption a SecureString comes back as ciphertext, which would reach pg
      // as a connection string and fail somewhere far from the cause.
      assert.equal(command.input.WithDecryption, true);
      return { Parameter: { Value: 'postgres://neon/battlecloud?sslmode=verify-full' } };
    },
  };
  await resolveDatabaseUrl(env, reader);
  assert.equal(env['DATABASE_URL'], 'postgres://neon/battlecloud?sslmode=verify-full');
});

test('a parameter that was never populated fails loudly', async () => {
  const env: NodeJS.ProcessEnv = { DATABASE_URL_PARAMETER: '/battle-cloud/database-url/api' };
  const reader: ParameterReader = { async send() { return { Parameter: { Value: '' } }; } };
  await assert.rejects(resolveDatabaseUrl(env, reader), /never written to it/);
});

test('neither variable set defers to loadConfig, which has the better message', async () => {
  const env: NodeJS.ProcessEnv = {};
  await resolveDatabaseUrl(env, NEVER_CALLED);
  assert.equal(env['DATABASE_URL'], undefined);
});
