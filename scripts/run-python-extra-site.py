from __future__ import annotations

import os
import runpy
import sys


def main() -> int:
    extra_site = os.environ.get("ERHU_EXTRA_SITE_PACKAGES", "").strip()
    if extra_site and os.path.isdir(extra_site) and extra_site not in sys.path:
        # Append after the interpreter's own site-packages so global CUDA torch
        # wins, while project-only dependencies can still be resolved.
        sys.path.append(extra_site)

    if len(sys.argv) >= 3 and sys.argv[1] == "-m":
        module_name = sys.argv[2]
        sys.argv = [module_name, *sys.argv[3:]]
        runpy.run_module(module_name, run_name="__main__", alter_sys=True)
        return 0

    if len(sys.argv) >= 3 and sys.argv[1] == "-c":
        command = sys.argv[2]
        sys.argv = ["-c", *sys.argv[3:]]
        exec(compile(command, "<string>", "exec"), {"__name__": "__main__"})
        return 0

    if len(sys.argv) >= 2:
        script = sys.argv[1]
        sys.argv = sys.argv[1:]
        runpy.run_path(script, run_name="__main__")
        return 0

    print("Usage: run-python-extra-site.py -m module [args...] | script.py [args...]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
