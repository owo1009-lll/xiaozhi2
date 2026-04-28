import json
import sys
import collections
import collections.abc


if not hasattr(collections, "MutableSequence"):
    collections.MutableSequence = collections.abc.MutableSequence
if not hasattr(collections, "MutableMapping"):
    collections.MutableMapping = collections.abc.MutableMapping
if not hasattr(collections, "MutableSet"):
    collections.MutableSet = collections.abc.MutableSet


def main():
    status = {
        "ok": True,
        "errors": [],
        "warnings": [],
    }

    try:
        import torch

        status["torch"] = getattr(torch, "__version__", "unknown")
        status["cudaAvailable"] = bool(torch.cuda.is_available())
        status["cudaDevice"] = torch.cuda.get_device_name(0) if torch.cuda.is_available() else ""
        if not status["cudaAvailable"]:
            status["warnings"].append("torch CUDA is not available; analysis will run on CPU.")
    except Exception as exc:
        status["ok"] = False
        status["errors"].append(f"torch unavailable: {exc}")

    try:
        import torchcrepe

        status["torchcrepe"] = getattr(torchcrepe, "__version__", "installed")
    except Exception as exc:
        status["ok"] = False
        status["errors"].append(f"torchcrepe unavailable: {exc}")

    try:
        import numpy as np

        if not hasattr(np, "float"):
            np.float = float  # type: ignore[attr-defined]
        if not hasattr(np, "int"):
            np.int = int  # type: ignore[attr-defined]
        if not hasattr(np, "complex"):
            np.complex = np.complex128  # type: ignore[attr-defined]
        status["numpy"] = getattr(np, "__version__", "installed")
    except Exception as exc:
        status["ok"] = False
        status["errors"].append(f"numpy unavailable: {exc}")

    try:
        import madmom

        status["madmom"] = getattr(madmom, "__version__", "installed")
    except Exception as exc:
        status["ok"] = False
        status["errors"].append(f"madmom unavailable: {exc}")

    print(json.dumps(status, ensure_ascii=False, indent=2))
    return 0 if status["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
