import Redis from 'ioredis';
import pg from 'pg';

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/voxmate';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const s3Endpoint = process.env.S3_ENDPOINT || 'http://localhost:9000';

const dbPool = new Pool({
  connectionString: databaseUrl,
  max: 2,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 2_000,
});

function formatError(error) {
  return error.message || error.code || error.name || 'Unknown error';
}

async function withTimeout(name, check, timeoutMs = 3_000) {
  const startedAt = Date.now();

  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`${name} health check timed out`)), timeoutMs);
      }),
    ]);

    return {
      status: 'ok',
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      status: 'error',
      latencyMs: Date.now() - startedAt,
      error: formatError(error),
    };
  }
}

export async function checkDependencies() {
  const [postgres, redisResult, minio] = await Promise.all([
    withTimeout('postgres', async () => {
      await dbPool.query('select 1');
    }),
    withTimeout('redis', async () => {
      const redis = new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 2_000,
        enableOfflineQueue: false,
        retryStrategy: null,
      });
      redis.on('error', () => {});

      try {
        await redis.connect();
        await redis.ping();
      } finally {
        redis.disconnect();
      }
    }),
    withTimeout('minio', async () => {
      const response = await fetch(`${s3Endpoint}/minio/health/live`);

      if (!response.ok) {
        throw new Error(`MinIO returned HTTP ${response.status}`);
      }
    }),
  ]);

  const checks = {
    postgres,
    redis: redisResult,
    minio,
  };

  const ready = Object.values(checks).every((check) => check.status === 'ok');

  return {
    status: ready ? 'ok' : 'degraded',
    checks,
  };
}
