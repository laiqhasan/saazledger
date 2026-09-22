import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../server/db/database';
import { runInitialMigrations } from '../server/db/migrations';
import {
  startMediaPackGenerationJob,
  getMediaJobStatusForClient,
} from '../server/services/media/mediaJobWorker';

beforeAll(() => {
  runInitialMigrations(db);
});

describe('Async media pack jobs', () => {
  it('returns a job id before source photos are resolved', async () => {
    let resolveStarted = false;
    let resolveFinished = false;

    const jobId = startMediaPackGenerationJob(
      {
        productTitle: 'Timeout Guard Pendant',
        productId: `async-timeout-${Date.now()}`,
      },
      {
        resolveFiles: async () => {
          resolveStarted = true;
          await new Promise((r) => setTimeout(r, 80));
          resolveFinished = true;
          throw new Error('stop-after-resolve');
        },
      }
    );

    expect(jobId).toMatch(/^job_/);
    expect(resolveFinished).toBe(false);

    const queued = getMediaJobStatusForClient(jobId);
    expect(queued).toBeTruthy();
    expect(['QUEUED', 'RUNNING']).toContain(queued.status);

    await new Promise((r) => setTimeout(r, 160));
    expect(resolveStarted).toBe(true);

    const failed = getMediaJobStatusForClient(jobId);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.error_message).toMatch(/stop-after-resolve/);
  });
});
