import { ECSClient, ListTasksCommand, RunTaskCommand } from '@aws-sdk/client-ecs';
import type { WorkerLaunchConfig } from './config.ts';

/**
 * Starts a worker when there is something to do.
 *
 * This is an optimization and never a correctness dependency. Jobs are rows claimed with
 * `FOR UPDATE SKIP LOCKED`, so a launch that is throttled, denied, or never attempted
 * delays a job until the scheduled sweep and cannot lose one. Every failure path here is
 * therefore logged and swallowed: the submission has already been durably enqueued by the
 * time this runs, and turning an ECS problem into a 500 would tell the client its
 * accepted job failed when it did not.
 */
export interface WorkerLauncher {
  ensureRunning(): Promise<void>;
}

/** What this needs from a logger, which is less than any real one provides. */
export interface Logger {
  info(payload: object, message: string): void;
  warn(payload: object, message: string): void;
}

/** The slice of the ECS client used here, so a test can supply a fake without the SDK. */
export interface EcsLike {
  send(command: ListTasksCommand | RunTaskCommand): Promise<unknown>;
}

/**
 * What the API does when no worker configuration is present: nothing, quietly.
 *
 * Compose and the test suite run without any of it, and the sweep covers a deployment
 * that is missing it. The loud version of a missing configuration lives in `loadConfig`,
 * which rejects a partially-set one, so reaching this object means the operator asked for
 * no trigger rather than mistyped one variable.
 */
export const NO_LAUNCHER: WorkerLauncher = {
  async ensureRunning(): Promise<void> {},
};

export class EcsWorkerLauncher implements WorkerLauncher {
  readonly #config: WorkerLaunchConfig;
  readonly #ecs: EcsLike;
  readonly #log: Logger;
  /**
   * Bounds what a slow or unreachable ECS costs a submission. The response does not depend
   * on the result, so the only reason to wait at all is that a fire-and-forget promise in
   * a container that may be recycled is a launch that silently never happened.
   */
  readonly #timeoutMs: number;

  // Fields rather than parameter properties: the suite runs under Node's type-stripping,
  // which rewrites no syntax and so cannot emit the assignments a parameter property implies.
  constructor(config: WorkerLaunchConfig, ecs: EcsLike, log: Logger, timeoutMs = 2_000) {
    this.#config = config;
    this.#ecs = ecs;
    this.#log = log;
    this.#timeoutMs = timeoutMs;
  }

  async ensureRunning(): Promise<void> {
    // Held so the timer can be cleared whichever side of the race wins. Leaving it armed
    // keeps the event loop alive for the rest of the timeout on every successful launch,
    // which in a test runner surfaces as a pending promise outliving its test and in a
    // container is a process that will not exit when asked.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expire = new Promise<never>((_resolve, reject) => {
      // Rejects rather than resolves, so a timeout reaches the same warning as any other
      // failure. Resolving would report a launch that did not happen as one that did.
      timer = setTimeout(
        () => reject(new Error(`ECS did not answer within ${this.#timeoutMs}ms`)),
        this.#timeoutMs,
      );
    });

    try {
      await Promise.race([this.#attempt(), expire]);
    } catch (cause) {
      this.#log.warn(
        { err: cause instanceof Error ? cause.message : String(cause) },
        'worker launch failed; the scheduled sweep will pick the job up',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async #attempt(): Promise<void> {
    const inFlight = await this.#countInFlight();
    if (inFlight >= this.#config.maxTasks) {
      // Not an error and not a dropped job. A worker drains until the queue has nothing
      // left for its build, so one already-running task will pick this up on its way
      // through. A task per submission would pay the 4 vCPU minute many times for work
      // one task does once.
      this.#log.info(
        { inFlight, maxTasks: this.#config.maxTasks },
        'worker launch skipped, at the concurrency cap',
      );
      return;
    }
    await this.#run();
    this.#log.info({ inFlight }, 'worker task started');
  }

  /**
   * `desiredStatus: RUNNING` counts tasks that are still PENDING as well, because pending
   * describes where a task is rather than where it is going. Counting only lastStatus
   * RUNNING would start a second task during the roughly seventeen seconds the first
   * spends attaching an ENI and pulling its image, which is exactly the window a burst of
   * submissions arrives in.
   */
  async #countInFlight(): Promise<number> {
    const result = (await this.#ecs.send(
      new ListTasksCommand({
        cluster: this.#config.cluster,
        family: this.#config.taskDefinition,
        desiredStatus: 'RUNNING',
      }),
    )) as { taskArns?: string[] };
    return result.taskArns?.length ?? 0;
  }

  async #run(): Promise<void> {
    await this.#ecs.send(
      new RunTaskCommand({
        cluster: this.#config.cluster,
        // The family without a revision, so a redeploy is picked up without touching this.
        taskDefinition: this.#config.taskDefinition,
        launchType: 'FARGATE',
        count: 1,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: [...this.#config.subnetIds],
            securityGroups: [this.#config.securityGroup],
            // Public subnets and no NAT gateway, so without a public address the task
            // starts and then cannot reach ECR, Neon, or CloudWatch.
            assignPublicIp: 'ENABLED',
          },
        },
      }),
    );
  }
}

export function createWorkerLauncher(
  config: WorkerLaunchConfig | null,
  log: Logger,
): WorkerLauncher {
  if (config === null) return NO_LAUNCHER;
  return new EcsWorkerLauncher(config, new ECSClient({}), log);
}
