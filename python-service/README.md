# Python Analyzer Service

This service is the deep-learning analysis backend for the `ai二胡` prototype.

## Current pipeline

The analyzer now follows this sequence:

1. Decode uploaded audio with `soundfile` or `ffmpeg + librosa`
2. Estimate frame-level pitch with `torchcrepe` when available, otherwise `librosa.pyin`
3. Detect onset candidates with `librosa`
4. Resolve the symbolic score from one of these sources:
   - `piecePack.notes`
   - inline `MusicXML`
   - inline `MIDI` when `pretty_midi` is installed
5. Convert the symbolic score into note events with expected onset/offset times
6. Build observed note segments from the performance pitch/onset tracks
7. Extract stable-segment pitch evidence and detect glide-like / vibrato-like note behavior
8. Align performance to score with `DTW`
9. Generate note-level and measure-level pitch/rhythm feedback with adaptive tolerance
10. Generate `summaryText`, `teacherComment`, and `practiceTargets` for the UI

## Endpoints

- `GET /health`
- `GET /config`
- `POST /analyze`

## Symbolic score input

`piecePack` may now include:

```json
{
  "scoreSource": {
    "format": "musicxml",
    "encoding": "utf-8",
    "data": "<score-partwise>...</score-partwise>"
  }
}
```

Or:

```json
{
  "scoreSource": {
    "format": "midi",
    "encoding": "base64",
    "data": "TVRoZAAAA..."
  }
}
```

If `scoreSource` is absent, the analyzer falls back to `piecePack.notes`.

## Install

```powershell
cd python-service
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
pip install -r requirements-optional.txt
uvicorn app:app --host 127.0.0.1 --port 8000
```

## Research notes

- `torchcrepe` is the current deep-learning core for pitch estimation.
- `DTW` is now the main score-performance alignment method.
- The analyzer now uses stable-segment pitch scoring, glide tolerance, vibrato tolerance, and low-confidence down-weighting for erhu-specific adaptation.
- Attention-based models are not part of the v1 pipeline; they are reserved for a later phase where you train a dedicated error-diagnosis model with real teacher-labeled data.
