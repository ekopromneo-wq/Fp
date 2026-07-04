import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const RECORDING_QUEUE_NAME = 'recording-processing';

export function createRedisConnection() {
  return new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
}

export function createRecordingQueue() {
  return new Queue(RECORDING_QUEUE_NAME, {
    connection: createRedisConnection(),
  });
}
