import json
import os
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
        "preferCudaPython": os.getenv("ERHU_PREFER_CUDA_PYTHON", ""),
        "torchConfiguredDevice": os.getenv("ERHU_TORCH_DEVICE", "cpu").strip().lower() or "cpu",
        "cudaVisibleDevices": os.getenv("CUDA_VISIBLE_DEVICES", ""),
        "cpuThreadLimit": os.getenv("ERHU_CPU_THREAD_LIMIT", ""),
        "threadEnv": {
            "OMP_NUM_THREADS": os.getenv("OMP_NUM_THREADS", ""),
            "MKL_NUM_THREADS": os.getenv("MKL_NUM_THREADS", ""),
            "OPENBLAS_NUM_THREADS": os.getenv("OPENBLAS_NUM_THREADS", ""),
            "NUMEXPR_NUM_THREADS": os.getenv("NUMEXPR_NUM_THREADS", ""),
        },
    }
    status["torchDevice"] = "cuda" if status["torchConfiguredDevice"] in {"cuda", "auto"} else "cpu"

    try:
        import torch

        status["torch"] = getattr(torch, "__version__", "unknown")
        status["cudaAvailable"] = bool(torch.cuda.is_available())
        status["cudaDevice"] = torch.cuda.get_device_name(0) if torch.cuda.is_available() else ""
        status["torchNumThreads"] = int(torch.get_num_threads())
        if status["torchDevice"] != "cpu":
            status["warnings"].append("ERHU_TORCH_DEVICE is not cpu; analysis may use CUDA if available.")
        elif status["cudaAvailable"]:
            status["warnings"].append("CUDA is installed but ERHU_TORCH_DEVICE=cpu, so analyzer inference remains CPU-only.")
        else:
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
