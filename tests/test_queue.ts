/*
import { Queue } from '@src/classes';
import { describe, beforeEach, it } from 'mocha';
import { expect, assert } from 'chai';
import * as IORedis from 'ioredis';
import { v4 } from 'uuid';
import { Worker } from '@src/classes/worker';
import { after } from 'lodash';
import { QueueEvents } from '@src/classes/queue-events';
import { QueueScheduler } from '@src/classes/queue-scheduler';

describe('Queue', function() {
  let queue: Queue;
  let queueName: string;
  let queueEvents: QueueEvents;

  beforeEach(function() {
    client = new IORedis();
  });

  beforeEach(async function() {
    queueName = '{test-' + v4() + '}';
    queue = new Queue(queueName);
    queueEvents = new QueueEvents(queueName);
    await queueEvents.init();
  });

  afterEach(async function() {
    await queue.close();
    await queueEvents.close();
    await removeAllQueueData(new IORedis(), queueName);
  });

  it('creates a queue with default job options', () => {
    const defaultJobOptions = { removeOnComplete: true };
    const queue = new Queue('custom', {
      defaultJobOptions,
    });

    expect(queue.defaultJobOptions).to.be.eql(defaultJobOptions);
  });

  describe('bulk jobs', () => {
    it('should default name of job', () => {
      const queue = new Queue('custom');

      return queue.addBulk([{ name: 'specified' }, {}]).then(jobs => {
        expect(jobs).to.have.length(2);

        expect(jobs[0].name).to.equal('specified');
        expect(jobs[1].name).to.equal('__default__');
      });
    });

    it('should default options from queue', () => {
      const queue = new Queue('custom', {
        defaultJobOptions: {
          removeOnComplete: true,
        },
      });

      return queue.addBulk([{}]).then(jobs => {
        expect(jobs[0].opts.removeOnComplete).to.equal(true);
      });
    });
  });
});
*/

import { expect } from 'chai';
import { after } from 'lodash';
import { default as IORedis } from 'ioredis';
import { describe, beforeEach, it } from 'mocha';
import * as sinon from 'sinon';
import { v4 } from 'uuid';
import { FlowProducer, Job, Queue, Worker } from '../src/classes';
import { delay, removeAllQueueData } from '../src/utils';

describe('queues', function () {
  const sandbox = sinon.createSandbox();

  let queue: Queue;
  let queueName: string;

  const connection = { host: 'localhost' };

  beforeEach(async function () {
    queueName = `{test-${v4()}}`;
    queue = new Queue(queueName, { connection });
    await queue.waitUntilReady();
  });

  afterEach(async function () {
    sandbox.restore();
    await queue.close();
    await removeAllQueueData(new IORedis(), queueName);
  });

  //TODO: restore this tests in next breaking change
  describe.skip('.add', () => {
    describe('when jobId is provided as integer', () => {
      it('throws error', async function () {
        await expect(
          queue.add('test', { foo: 1 }, { jobId: '2' }),
        ).to.be.rejectedWith('Custom Ids cannot be integers');
      });
    });
  });

  describe('when empty name is provided', () => {
    it('throws an error', function () {
      expect(
        () =>
          new Queue('', {
            connection,
          }),
      ).to.throw('Queue name must be provided');
    });
  });

  describe('.drain', () => {
    it('count added, unprocessed jobs', async () => {
      const maxJobs = 100;
      const added: Promise<Job<any, any, string>>[] = [];

      for (let i = 1; i <= maxJobs; i++) {
        added.push(queue.add('test', { foo: 'bar', num: i }, { priority: i }));
      }

      await Promise.all(added);
      const count = await queue.count();
      expect(count).to.be.eql(100);
      const priorityCount = await queue.getJobCountByTypes('prioritized');
      expect(priorityCount).to.be.eql(100);

      await queue.drain();
      const countAfterEmpty = await queue.count();
      expect(countAfterEmpty).to.be.eql(0);

      const client = await queue.client;
      const keys = await client.keys(`bull:${queue.name}:*`);

      expect(keys.length).to.be.eql(4);
    });

    describe('when having a flow', async () => {
      describe('when parent belongs to same queue', async () => {
        describe('when parent has more than 1 pending children in the same queue', async () => {
          it('deletes parent record', async () => {
            await queue.waitUntilReady();
            const name = 'child-job';

            const flow = new FlowProducer({ connection });
            await flow.add({
              name: 'parent-job',
              queueName,
              data: {},
              children: [
                { name, data: { idx: 0, foo: 'bar' }, queueName },
                { name, data: { idx: 1, foo: 'baz' }, queueName },
                { name, data: { idx: 2, foo: 'qux' }, queueName },
              ],
            });

            const count = await queue.count();
            expect(count).to.be.eql(4);

            await queue.drain();

            const client = await queue.client;
            const keys = await client.keys(`bull:${queue.name}:*`);

            expect(keys.length).to.be.eql(3);

            const countAfterEmpty = await queue.count();
            expect(countAfterEmpty).to.be.eql(0);

            await flow.close();
          });
        });

        describe('when parent has only 1 pending child in the same queue', async () => {
          it('deletes parent record', async () => {
            await queue.waitUntilReady();
            const name = 'child-job';

            const flow = new FlowProducer({ connection });
            await flow.add({
              name: 'parent-job',
              queueName,
              data: {},
              children: [{ name, data: { idx: 0, foo: 'bar' }, queueName }],
            });

            const count = await queue.count();
            expect(count).to.be.eql(2);

            await queue.drain();

            const client = await queue.client;
            const keys = await client.keys(`bull:${queue.name}:*`);

            expect(keys.length).to.be.eql(3);

            const countAfterEmpty = await queue.count();
            expect(countAfterEmpty).to.be.eql(0);

            await flow.close();
          });
        });

        describe('when parent has pending children in different queue', async () => {
          it('keeps parent in waiting-children', async () => {
            await queue.waitUntilReady();
            const childrenQueueName = `${queueName}-child-${v4()}`;
            const childrenQueue = new Queue(childrenQueueName, { connection });
            await childrenQueue.waitUntilReady();
            const name = 'child-job';

            const flow = new FlowProducer({ connection });
            await flow.add({
              name: 'parent-job',
              queueName,
              data: {},
              children: [
                {
                  name,
                  data: { idx: 0, foo: 'bar' },
                  queueName: childrenQueueName,
                },
              ],
            });

            const count = await queue.count();
            expect(count).to.be.eql(1);

            await queue.drain();

            const client = await queue.client;
            const keys = await client.keys(`bull:${queue.name}:*`);

            expect(keys.length).to.be.eql(6);

            const countAfterEmpty = await queue.count();
            expect(countAfterEmpty).to.be.eql(1);

            await flow.close();
          });
        });
      });

      describe('when parent belongs to different queue', async () => {
        describe('when parent has more than 1 pending children', async () => {
          it('deletes each children until trying to move parent to wait', async () => {
            await queue.waitUntilReady();
            const parentQueueName = `${queueName}-parent-${v4()}`;
            const parentQueue = new Queue(parentQueueName, { connection });
            await parentQueue.waitUntilReady();
            const name = 'child-job';

            const flow = new FlowProducer({ connection });
            await flow.add({
              name: 'parent-job',
              queueName: parentQueueName,
              data: {},
              children: [
                { name, data: { idx: 0, foo: 'bar' }, queueName },
                { name, data: { idx: 1, foo: 'baz' }, queueName },
                { name, data: { idx: 2, foo: 'qux' }, queueName },
              ],
            });

            const count = await queue.count();
            expect(count).to.be.eql(3);

            await queue.drain();

            const client = await queue.client;
            const keys = await client.keys(`bull:${queue.name}:*`);

            expect(keys.length).to.be.eql(3);

            const countAfterEmpty = await queue.count();
            expect(countAfterEmpty).to.be.eql(0);

            const childrenFailedCount = await queue.getJobCountByTypes(
              'failed',
            );
            expect(childrenFailedCount).to.be.eql(0);

            const parentWaitCount = await parentQueue.getJobCountByTypes(
              'wait',
            );
            expect(parentWaitCount).to.be.eql(1);
            await parentQueue.close();
            await flow.close();
            await removeAllQueueData(new IORedis(), parentQueueName);
          });
        });

        describe('when parent has only 1 pending children', async () => {
          it('moves parent to wait to try to process it', async () => {
            await queue.waitUntilReady();
            const parentQueueName = `${queueName}-parent-${v4()}`;
            const parentQueue = new Queue(parentQueueName, { connection });
            await parentQueue.waitUntilReady();
            const name = 'child-job';

            const flow = new FlowProducer({ connection });
            await flow.add({
              name: 'parent-job',
              queueName: parentQueueName,
              data: {},
              children: [{ name, data: { idx: 0, foo: 'bar' }, queueName }],
            });

            const count = await queue.count();
            expect(count).to.be.eql(1);

            await queue.drain();

            const client = await queue.client;
            const keys = await client.keys(`bull:${queue.name}:*`);

            expect(keys.length).to.be.eql(3);

            const countAfterEmpty = await queue.count();
            expect(countAfterEmpty).to.be.eql(0);

            const failedCount = await queue.getJobCountByTypes('failed');
            expect(failedCount).to.be.eql(0);

            const parentWaitCount = await parentQueue.getJobCountByTypes(
              'wait',
            );
            expect(parentWaitCount).to.be.eql(1);
            await parentQueue.close();
            await flow.close();
            await removeAllQueueData(new IORedis(), parentQueueName);
          });
        });
      });
    });

    describe('when delayed option is provided as false', () => {
      it('clean queue without delayed jobs', async () => {
        const maxJobs = 50;
        const maxDelayedJobs = 50;
        const added = [];
        const delayed = [];

        for (let i = 1; i <= maxJobs; i++) {
          added.push(queue.add('test', { foo: 'bar', num: i }));
        }

        for (let i = 1; i <= maxDelayedJobs; i++) {
          delayed.push(
            queue.add('test', { foo: 'bar', num: i }, { delay: 10000 }),
          );
        }

        await Promise.all(added);
        await Promise.all(delayed);
        const count = await queue.count();
        expect(count).to.be.eql(maxJobs + maxDelayedJobs);
        await queue.drain(false);
        const countAfterEmpty = await queue.count();
        expect(countAfterEmpty).to.be.eql(50);
      });
    });

    describe('when delayed option is provided as true', () => {
      it('clean queue including delayed jobs', async () => {
        const maxJobs = 50;
        const maxDelayedJobs = 50;
        const added = [];
        const delayed = [];

        for (let i = 1; i <= maxJobs; i++) {
          added.push(queue.add('test', { foo: 'bar', num: i }));
        }

        for (let i = 1; i <= maxDelayedJobs; i++) {
          delayed.push(
            queue.add('test', { foo: 'bar', num: i }, { delay: 10000 }),
          );
        }

        await Promise.all(added);
        await Promise.all(delayed);
        const count = await queue.count();
        expect(count).to.be.eql(maxJobs + maxDelayedJobs);
        await queue.drain(true);
        const countAfterEmpty = await queue.count();
        expect(countAfterEmpty).to.be.eql(0);
      });
    });

    describe('when queue is paused', () => {
      it('clean queue including paused jobs', async () => {
        const maxJobs = 50;
        const added = [];

        await queue.pause();
        for (let i = 1; i <= maxJobs; i++) {
          added.push(queue.add('test', { foo: 'bar', num: i }));
        }

        await Promise.all(added);
        const count = await queue.count();
        expect(count).to.be.eql(maxJobs);
        const count2 = await queue.getJobCounts('paused');
        expect(count2.paused).to.be.eql(maxJobs);
        await queue.drain();
        const countAfterEmpty = await queue.count();
        expect(countAfterEmpty).to.be.eql(0);
      });
    });
  });

  describe('.removeDeprecatedPriorityKey', () => {
    it('removes old priority key', async () => {
      const client = await queue.client;
      await client.zadd(`bull:${queue.name}:priority`, 1, 'a');
      await client.zadd(`bull:${queue.name}:priority`, 2, 'b');

      const count = await client.zcard(`bull:${queue.name}:priority`);

      expect(count).to.be.eql(2);

      await queue.removeDeprecatedPriorityKey();

      const updatedCount = await client.zcard(`bull:${queue.name}:priority`);

      expect(updatedCount).to.be.eql(0);
    });
  });

  describe('.retryJobs', () => {
    it('retries all failed jobs by default', async () => {
      await queue.waitUntilReady();
      const jobCount = 8;

      let fail = true;
      const worker = new Worker(
        queueName,
        async () => {
          await delay(10);
          if (fail) {
            throw new Error('failed');
          }
        },
        { connection },
      );
      await worker.waitUntilReady();

      let order = 0;
      const failing = new Promise<void>(resolve => {
        worker.on('failed', job => {
          expect(order).to.be.eql(job.data.idx);
          if (order === jobCount - 1) {
            resolve();
          }
          order++;
        });
      });

      for (const index of Array.from(Array(jobCount).keys())) {
        await queue.add('test', { idx: index });
      }

      await failing;

      const failedCount = await queue.getJobCounts('failed');
      expect(failedCount.failed).to.be.equal(jobCount);

      order = 0;
      const completing = new Promise<void>(resolve => {
        worker.on('completed', job => {
          expect(order).to.be.eql(job.data.idx);
          if (order === jobCount - 1) {
            resolve();
          }
          order++;
        });
      });

      fail = false;
      await queue.retryJobs({ count: 2 });

      await completing;

      const completedCount = await queue.getJobCounts('completed');
      expect(completedCount.completed).to.be.equal(jobCount);

      await worker.close();
    });

    describe('when completed state is provided', () => {
      it('retries all completed jobs', async () => {
        await queue.waitUntilReady();
        const jobCount = 8;

        const worker = new Worker(
          queueName,
          async () => {
            await delay(25);
          },
          { connection },
        );
        await worker.waitUntilReady();

        const completing1 = new Promise(resolve => {
          worker.on('completed', after(jobCount, resolve));
        });

        for (const index of Array.from(Array(jobCount).keys())) {
          await queue.add('test', { idx: index });
        }

        await completing1;

        const completedCount1 = await queue.getJobCounts('completed');
        expect(completedCount1.completed).to.be.equal(jobCount);

        const completing2 = new Promise(resolve => {
          worker.on('completed', after(jobCount, resolve));
        });

        await queue.retryJobs({ count: 2, state: 'completed' });

        const completedCount2 = await queue.getJobCounts('completed');
        expect(completedCount2.completed).to.be.equal(0);

        await completing2;

        const completedCount = await queue.getJobCounts('completed');
        expect(completedCount.completed).to.be.equal(jobCount);

        await worker.close();
      });
    });

    describe('when timestamp is provided', () => {
      it('should retry all failed jobs before specific timestamp', async () => {
        await queue.waitUntilReady();
        const jobCount = 8;

        let fail = true;
        const worker = new Worker(
          queueName,
          async () => {
            await delay(50);
            if (fail) {
              throw new Error('failed');
            }
          },
          { connection },
        );
        await worker.waitUntilReady();

        let order = 0;
        let timestamp;
        const failing = new Promise<void>(resolve => {
          worker.on('failed', job => {
            expect(order).to.be.eql(job.data.idx);
            if (job.data.idx === jobCount / 2 - 1) {
              timestamp = Date.now();
            }
            if (order === jobCount - 1) {
              resolve();
            }
            order++;
          });
        });

        for (const index of Array.from(Array(jobCount).keys())) {
          await queue.add('test', { idx: index });
        }

        await failing;

        const failedCount = await queue.getJobCounts('failed');
        expect(failedCount.failed).to.be.equal(jobCount);

        order = 0;
        const completing = new Promise<void>(resolve => {
          worker.on('completed', job => {
            expect(order).to.be.eql(job.data.idx);
            if (order === jobCount / 2 - 1) {
              resolve();
            }
            order++;
          });
        });

        fail = false;

        await queue.retryJobs({ count: 2, timestamp });
        await completing;

        const count = await queue.getJobCounts('completed', 'failed');
        expect(count.completed).to.be.equal(jobCount / 2);
        expect(count.failed).to.be.equal(jobCount / 2);

        await worker.close();
      });
    });

    describe('when queue is paused', () => {
      it('moves retried jobs to paused', async () => {
        await queue.waitUntilReady();
        const jobCount = 8;

        let fail = true;
        const worker = new Worker(
          queueName,
          async () => {
            await delay(10);
            if (fail) {
              throw new Error('failed');
            }
          },
          { connection },
        );
        await worker.waitUntilReady();

        let order = 0;
        const failing = new Promise<void>(resolve => {
          worker.on('failed', job => {
            expect(order).to.be.eql(job.data.idx);
            if (order === jobCount - 1) {
              resolve();
            }
            order++;
          });
        });

        for (const index of Array.from(Array(jobCount).keys())) {
          await queue.add('test', { idx: index });
        }

        await failing;

        const failedCount = await queue.getJobCounts('failed');
        expect(failedCount.failed).to.be.equal(jobCount);

        order = 0;

        fail = false;
        await queue.pause();
        await queue.retryJobs({ count: 2 });

        const pausedCount = await queue.getJobCounts('paused');
        expect(pausedCount.paused).to.be.equal(jobCount);

        await worker.close();
      });
    });
  });

  describe('.promoteJobs', () => {
    it('promotes all delayed jobs by default', async () => {
      await queue.waitUntilReady();
      const jobCount = 8;

      for (let i = 0; i < jobCount; i++) {
        await queue.add('test', { idx: i }, { delay: 10000 });
      }

      const delayedCount = await queue.getJobCounts('delayed');
      expect(delayedCount.delayed).to.be.equal(jobCount);

      await queue.promoteJobs();

      const waitingCount = await queue.getJobCounts('waiting');
      expect(waitingCount.waiting).to.be.equal(jobCount);

      const worker = new Worker(
        queueName,
        async () => {
          await delay(10);
        },
        { connection },
      );
      await worker.waitUntilReady();

      const completing = new Promise<number>(resolve => {
        worker.on('completed', after(jobCount, resolve));
      });

      await completing;

      const promotedCount = await queue.getJobCounts('delayed');
      expect(promotedCount.delayed).to.be.equal(0);

      await worker.close();
    });
  });
});
