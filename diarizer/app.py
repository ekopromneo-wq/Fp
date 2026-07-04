import os
import tempfile

import torch

# PyTorch 2.6 flipped the default of `weights_only` to True, which breaks loading
# pyannote/whisperx checkpoints that pickle omegaconf config objects. We only ever
# load fixed, known checkpoints from the official pyannote/whisperx Hugging Face
# repos configured via HF_TOKEN below, so restoring the old, permissive default is
# an acceptable trade-off for this internal service.
_original_torch_load = torch.load


def _patched_torch_load(*args, **kwargs):
    kwargs["weights_only"] = False
    return _original_torch_load(*args, **kwargs)


torch.load = _patched_torch_load

from fastapi import FastAPI, File, HTTPException, UploadFile  # noqa: E402
import whisperx  # noqa: E402

app = FastAPI(title="voxmate-diarizer")

DEVICE = os.environ.get("WHISPERX_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("WHISPERX_COMPUTE_TYPE", "int8")
MODEL_SIZE = os.environ.get("WHISPERX_MODEL", "medium")
LANGUAGE = os.environ.get("WHISPERX_LANGUAGE", "ru")
HF_TOKEN = os.environ.get("HF_TOKEN", "")
BATCH_SIZE = int(os.environ.get("WHISPERX_BATCH_SIZE", "8"))

_models = {}


def get_asr_model():
    if "asr" not in _models:
        _models["asr"] = whisperx.load_model(MODEL_SIZE, DEVICE, compute_type=COMPUTE_TYPE, language=LANGUAGE)

    return _models["asr"]


def get_diarize_model():
    if "diarize" not in _models:
        if not HF_TOKEN:
            raise RuntimeError("HF_TOKEN is not configured on the diarizer service")

        _models["diarize"] = whisperx.diarize.DiarizationPipeline(use_auth_token=HF_TOKEN, device=DEVICE)

    return _models["diarize"]


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/diarize")
async def diarize(file: UploadFile = File(...)):
    suffix = os.path.splitext(file.filename or "")[1] or ".audio"
    tmp_path = None

    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(await file.read())
            tmp_path = tmp.name

        audio = whisperx.load_audio(tmp_path)

        asr_model = get_asr_model()
        result = asr_model.transcribe(audio, batch_size=BATCH_SIZE, language=LANGUAGE)

        align_model, metadata = whisperx.load_align_model(language_code=result.get("language", LANGUAGE), device=DEVICE)
        result = whisperx.align(result["segments"], align_model, metadata, audio, DEVICE, return_char_alignments=False)

        diarize_model = get_diarize_model()
        diarize_segments = diarize_model(audio)
        result = whisperx.assign_word_speakers(diarize_segments, result)

        segments = [
            {
                "start": segment.get("start"),
                "end": segment.get("end"),
                "speaker": segment.get("speaker", "SPEAKER_00"),
                "text": segment.get("text", "").strip(),
            }
            for segment in result["segments"]
            if segment.get("text", "").strip()
        ]

        return {"language": result.get("language", LANGUAGE), "segments": segments}
    except Exception as error:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(error)) from error
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)
