import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { pool, transaction } from '../src/db.js';

async function main() {
  const recordingId = process.argv[2];
  const resultPath = process.argv[3];

  if (!recordingId || !resultPath) {
    console.error('Usage: node scripts/load-shopot-transcript.js <recordingId> <resultJsonPath>');
    process.exit(1);
  }

  const result = JSON.parse(await readFile(resultPath, 'utf8'));

  await transaction(async (client) => {
    const job = await client.query(
      `
        insert into processing_jobs (recording_id, status)
        values ($1, 'done')
        returning id
      `,
      [recordingId],
    );

    await client.query(
      `
        insert into transcripts (recording_id, job_id, language, text, segments)
        values ($1, $2, 'ru', $3, $4::jsonb)
      `,
      [recordingId, job.rows[0].id, result.text, JSON.stringify(result.segments)],
    );

    await client.query(
      `
        update recordings
        set status = 'done', updated_at = now()
        where id = $1
      `,
      [recordingId],
    );
  });

  console.log(`Loaded transcript for recording ${recordingId}: ${result.segments.length} segments, ${result.speakerCount} speakers.`);
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
