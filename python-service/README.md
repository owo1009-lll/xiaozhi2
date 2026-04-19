# Python Analyzer Skeleton

This service provides the external analyzer contract used by the `ai二胡` prototype.

## Purpose

- Accept the same payload sent from the Node gateway
- Return a stable analysis JSON shape for pitch and rhythm feedback
- Provide clear insertion points for `torchcrepe`, `librosa`, `soundfile`, and future score-alignment logic

## Quick Start

```bash
cd python-service
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000
```

Optional research dependencies:

```bash
pip install -r requirements-optional.txt
```

## Endpoints

- `GET /health`: readiness and dependency report
- `GET /config`: public settings snapshot
- `POST /analyze`: external analyzer contract for the Node server

## Node Integration

Set the root project `.env`:

```bash
ERHU_ANALYZER_URL=http://127.0.0.1:8000
```

When `ERHU_ANALYZER_URL` is unset, the Node server falls back to the local mock analyzer.

## Next Research Steps

1. Replace the synthetic pitch track with real `torchcrepe` inference.
2. Decode uploaded audio with `soundfile` and add onset extraction with `librosa`.
3. Add score-informed alignment and stable-segment pitch scoring.
4. Export frame-level diagnostics for teacher validation.
