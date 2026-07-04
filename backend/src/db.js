import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/voxmate',
  max: 10,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 3_000,
});

export async function query(text, params) {
  return pool.query(text, params);
}

export async function transaction(callback) {
  const client = await pool.connect();

  try {
    await client.query('begin');
    const result = await callback(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
