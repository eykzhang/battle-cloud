import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ListTasksCommand, RunTaskCommand } from '@aws-sdk/client-ecs';
import { EcsWorkerLauncher, type EcsLike, type Logger } from '../src/worker.ts';
import { loadConfig, ConfigError } from '../src/config.ts';

const LAUNCH = {
  cluster: 'battle-cloud',
  taskDefinition: 'battle-cloud-worker',
  subnetIds: ['subnet-a', 'subnet-b'],
  securityGroup: 'sg-1',
  maxTasks: 2,
};

function recorder() {
  const lines: { level: string; payload: object; message: string }[] = [];
  const log: Logger = {
    info: (payload, message) => lines.push({ level: 'info', payload, message }),
    warn: (payload, message) => lines.push({ level: 'warn', payload, message }),
  };
  return { log, lines };
}

/** An ECS that reports `running` tasks and records every command it is sent. */
function fakeEcs(running: number, behavior: Partial<{ listThrows: Error; runThrows: Error }> = {}) {
  const sent: (ListTasksCommand | RunTaskCommand)[] = [];
  const ecs: EcsLike = {
    async send(command) {
      sent.push(command);
      if (command instanceof ListTasksCommand) {
        if (behavior.listThrows) throw behavior.listThrows;
        return { taskArns: Array.from({ length: running }, (_, i) => `arn:task/${i}`) };
      }
      if (behavior.runThrows) throw behavior.runThrows;
      return {};
    },
  };
  return { ecs, sent };
}

const runs = (sent: unknown[]) => sent.filter((c) => c instanceof RunTaskCommand);

test('a queued job with no workers running starts one', async () => {
  const { ecs, sent } = fakeEcs(0);
  const { log, lines } = recorder();
  await new EcsWorkerLauncher(LAUNCH, ecs, log).ensureRunning();

  assert.equal(runs(sent).length, 1);
  const started = runs(sent)[0] as RunTaskCommand;
  assert.equal(started.input.cluster, 'battle-cloud');
  assert.equal(started.input.launchType, 'FARGATE');
  assert.equal(started.input.count, 1);
  // Without a public IP the task cannot reach ECR, Neon, or CloudWatch, because the
  // subnets are public and there is no NAT gateway.
  assert.equal(started.input.networkConfiguration?.awsvpcConfiguration?.assignPublicIp, 'ENABLED');
  assert.deepEqual(started.input.networkConfiguration?.awsvpcConfiguration?.subnets, ['subnet-a', 'subnet-b']);
  assert.equal(lines.at(-1)?.message, 'worker task started');
});

test('the cap is a ceiling, not a suggestion', async () => {
  const { ecs, sent } = fakeEcs(2);
  const { log, lines } = recorder();
  await new EcsWorkerLauncher(LAUNCH, ecs, log).ensureRunning();

  assert.equal(runs(sent).length, 0, 'at the cap, nothing should start');
  assert.match(lines.at(-1)?.message ?? '', /concurrency cap/);
});

test('a task still pending counts against the cap', async () => {
  // ECS reports a pending task under desiredStatus RUNNING, because pending is where a
  // task is rather than where it is going. Asking for anything else would start a second
  // worker during the seventeen seconds the first spends pulling its image.
  const { ecs, sent } = fakeEcs(0);
  await new EcsWorkerLauncher(LAUNCH, ecs, recorder().log).ensureRunning();

  const listed = sent[0] as ListTasksCommand;
  assert.equal(listed.input.desiredStatus, 'RUNNING');
  assert.equal(listed.input.family, 'battle-cloud-worker');
});

test('a failure to count does not reach the caller', async () => {
  const { ecs, sent } = fakeEcs(0, { listThrows: new Error('ecs is down') });
  const { log, lines } = recorder();

  await assert.doesNotReject(() => new EcsWorkerLauncher(LAUNCH, ecs, log).ensureRunning());
  assert.equal(runs(sent).length, 0);
  assert.equal(lines.at(-1)?.level, 'warn');
  assert.match(lines.at(-1)?.message ?? '', /sweep will pick the job up/);
});

test('a failure to start does not reach the caller', async () => {
  const { ecs } = fakeEcs(0, { runThrows: new Error('throttled') });
  const { log, lines } = recorder();

  await assert.doesNotReject(() => new EcsWorkerLauncher(LAUNCH, ecs, log).ensureRunning());
  assert.equal(lines.at(-1)?.level, 'warn');
});

test('an ECS that never answers bounds what the submission waits', async () => {
  // Settled explicitly at the end rather than left hanging. A promise that never resolves
  // outlives the test, and the runner reports that as a failure of whichever test happens
  // to be last, which is a considerably worse thing to debug than this line is to write.
  let answer: (value: unknown) => void = () => {};
  const ecs: EcsLike = { send: () => new Promise((resolve) => { answer = resolve; }) };
  const { log, lines } = recorder();

  const started = Date.now();
  await new EcsWorkerLauncher(LAUNCH, ecs, log, 25).ensureRunning();
  const waited = Date.now() - started;

  assert.ok(waited < 1_000, `expected the timeout to fire, waited ${waited}ms`);
  assert.equal(lines.at(-1)?.level, 'warn');
  assert.match(JSON.stringify(lines.at(-1)?.payload ?? {}), /did not answer/);

  answer({ taskArns: [] });
});

test('no worker variables means no trigger, which is what compose runs', () => {
  const config = loadConfig({ DATABASE_URL: 'postgres:///x' } as NodeJS.ProcessEnv);
  assert.equal(config.workerLaunch, null);
});

test('a partially configured trigger is refused rather than silently disabled', () => {
  assert.throws(
    () =>
      loadConfig({
        DATABASE_URL: 'postgres:///x',
        WORKER_CLUSTER: 'battle-cloud',
        WORKER_TASK_DEFINITION: 'battle-cloud-worker',
        // subnets and security group missing
      } as NodeJS.ProcessEnv),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /WORKER_SUBNET_IDS/);
      assert.match(error.message, /WORKER_SECURITY_GROUP/);
      return true;
    },
  );
});

test('a full configuration splits the subnet list and defaults the cap', () => {
  const config = loadConfig({
    DATABASE_URL: 'postgres:///x',
    WORKER_CLUSTER: 'battle-cloud',
    WORKER_TASK_DEFINITION: 'battle-cloud-worker',
    WORKER_SUBNET_IDS: 'subnet-a, subnet-b',
    WORKER_SECURITY_GROUP: 'sg-1',
  } as NodeJS.ProcessEnv);

  assert.deepEqual(config.workerLaunch?.subnetIds, ['subnet-a', 'subnet-b']);
  assert.equal(config.workerLaunch?.maxTasks, 2);
});
