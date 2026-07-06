import { transcribeWithOpenRouter } from './openrouterAsr.js';
import { trySplitTranscriptBySpeaker } from './speakerSplit.js';

const DEFAULT_KIMI_MODEL = 'moonshotai/kimi-k2.6';

/**
 * Kimi models on OpenRouter don't accept audio input (text/image only), unlike
 * Gemini which listens to the recording directly. So "diarization via Kimi" is
 * a two-step text-based approach: plain OpenRouter ASR for the transcript,
 * then Kimi splits that transcript by speaker and guesses names from context -
 * same mechanism as the generic text-based fallback, but with an explicit,
 * user-chosen model instead of the default gpt-4o-mini.
 * Returns null (instead of throwing) on any failure, so callers can fall back
 * to the plain ASR + default text-based speaker split.
 */
export async function transcribeWithKimi(file, audioBuffer, config = {}) {
  const model = config.kimiModel || DEFAULT_KIMI_MODEL;

  try {
    const transcription = await transcribeWithOpenRouter(file, audioBuffer);
    const transcriptText = transcription?.text;

    if (!transcriptText) {
      return null;
    }

    const speakerSplit = await trySplitTranscriptBySpeaker(transcriptText, model);

    if (!speakerSplit) {
      return null;
    }

    return speakerSplit;
  } catch (error) {
    console.warn('Kimi diarization failed, falling back:', error.message);
    return null;
  }
}
