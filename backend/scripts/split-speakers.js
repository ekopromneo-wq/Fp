import 'dotenv/config';
import { pool } from '../src/db.js';
import { trySplitTranscriptBySpeaker } from '../src/speakerSplit.js';

async function main() {
  const recordingId = process.argv[2];

  if (!recordingId) {
    console.error('Usage: node scripts/split-speakers.js <recordingId>');
    process.exit(1);
  }

  const { rows } = await pool.query(
    `select t.id as transcript_id, t.text, r.title
     from transcripts t
     join recordings r on r.id = t.recording_id
     where t.recording_id = $1`,
    [recordingId],
  );

  const transcript = rows[0];

  if (!transcript) {
    console.error(`No transcript found for recording ${recordingId}`);
    process.exit(1);
  }

  console.log(`Processing "${transcript.title}" (transcript ${transcript.transcript_id}, ${transcript.text.length} chars)...`);

  const result = await trySplitTranscriptBySpeaker(transcript.text);

  if (!result) {
    console.error('Speaker split failed or was skipped (see warnings above), aborting without writing changes');
    process.exit(1);
  }

  await pool.query('update transcripts set text = $1, segments = $2, updated_at = now() where id = $3', [
    result.text,
    JSON.stringify(result.segments),
    transcript.transcript_id,
  ]);

  console.log(`Transcript updated with ${result.segments.length} segments across ${result.speakerCount} speakers.`);
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
