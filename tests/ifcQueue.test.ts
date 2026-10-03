import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packageUsd } from '../src/ifc/convertIfc.ts';

test('USD packaging queues concurrent jobs and replaces a failed worker before continuing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  type Job = { worker: FakeWorker; id: number; metadata: string };
  const jobs: Job[] = [];
  let waiting: ((job: Job) => void) | undefined;
  let posts = 0;
  const nextJob = () => jobs.length ? Promise.resolve(jobs.shift()!) : new Promise<Job>((resolve) => { waiting = resolve; });
  class FakeWorker extends EventTarget {
    terminated = false;
    postMessage(data: { id: number; metadata: string }): void {
      posts++;
      const job = { worker: this, ...data };
      if (waiting) { const resolve = waiting; waiting = undefined; resolve(job); }
      else jobs.push(job);
    }
    terminate(): void { this.terminated = true; }
    done(id: number, value: number): void {
      this.dispatchEvent(new MessageEvent('message', { data: { type: 'usd', id, usdz: new Uint8Array([value]).buffer } }));
    }
  }
  const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { baseURI: 'https://viewer.example.com/' } });
  t.after(() => {
    t.mock.timers.tick(30_000);
    if (workerDescriptor) Object.defineProperty(globalThis, 'Worker', workerDescriptor); else Reflect.deleteProperty(globalThis, 'Worker');
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor); else Reflect.deleteProperty(globalThis, 'document');
  });

  const first = packageUsd(new ArrayBuffer(0), 'first', () => {});
  const second = packageUsd(new ArrayBuffer(0), 'second', () => {});
  const job1 = await nextJob();
  assert.equal(posts, 1);
  assert.equal(job1.metadata, 'first');
  job1.worker.done(job1.id, 1);
  assert.deepEqual(new Uint8Array(await first), new Uint8Array([1]));
  const job2 = await nextJob();
  assert.equal(job2.metadata, 'second');
  assert.equal(job2.worker, job1.worker);
  const failure = assert.rejects(second, /conversion failed/);
  job2.worker.dispatchEvent(new MessageEvent('message', { data: { type: 'error', id: job2.id, message: 'conversion failed' } }));
  await failure;
  assert.equal(job2.worker.terminated, true);

  const third = packageUsd(new ArrayBuffer(0), 'third', () => {});
  const job3 = await nextJob();
  assert.notEqual(job3.worker, job2.worker);
  job3.worker.done(job3.id, 3);
  assert.deepEqual(new Uint8Array(await third), new Uint8Array([3]));
  t.mock.timers.tick(30_000);
  assert.equal(job3.worker.terminated, true);
});
