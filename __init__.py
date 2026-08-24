"""
ComfyUI-AMDMonitor
==================
VRAM / system monitor that works on AMD (ROCm) cards.

Crystools reads GPU stats through pynvml, which is NVIDIA-only, so on an AMD card
it can only ever show CPU and RAM. ComfyUI itself already reports AMD VRAM
correctly via its own /system_stats endpoint -- it goes through PyTorch's HIP
backend rather than NVML. Most of this extension just displays what is already
there, in the browser.

This file adds what the browser cannot get:

  /amdmonitor/stats      swap, CPU, disk and network, via psutil (read-only)
  /amdmonitor/run/start  begin capturing a per-run log
  /amdmonitor/run/end    write the run record, append runs.csv, stop capturing
  /amdmonitor/alert      append a line to alerts.log
  /amdmonitor/runs       recent run records, for the History view

WHY IT WRITES FILES
-------------------
On a card without headroom, ROCm aborts the whole process when a model loads
partially. There is no traceback, and anything held only in the browser dies with
it. So the log is captured in Python and appended AS THE RUN PROGRESSES -- a
crash then leaves a file ending at the exact moment things went wrong, which is
the record you actually wanted.

WHERE IT WRITES
---------------
ComfyUI's user directory, never this folder: ComfyUI Manager replaces the
extension directory on update, which would wipe the history on every release.

Nothing is executed. Only this extension's own files under user/amdmonitor are
written, and old runs are pruned.
"""

import csv
import json
import logging
import os
import time

WEB_DIRECTORY = "./js"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["WEB_DIRECTORY", "NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

KEEP_RUNS = 50          # prune older run files beyond this
log = logging.getLogger("AMDMonitor")

try:
    import psutil
    _HAS_PSUTIL = True
except Exception:
    psutil = None
    _HAS_PSUTIL = False

_prev = {"t": None, "disk_r": 0, "disk_w": 0, "net_s": 0, "net_r": 0}


# ── where we store things ────────────────────────────────────────────────────

def _base_dir():
    """
    ComfyUI's user directory -- NOT this extension's folder, which Manager
    replaces on update.
    """
    try:
        import folder_paths
        root = folder_paths.get_user_directory()
    except Exception:
        root = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "..", "user")
    d = os.path.join(root, "amdmonitor")
    os.makedirs(os.path.join(d, "runs"), exist_ok=True)
    return d


def _output_dir():
    try:
        import folder_paths
        return folder_paths.get_output_directory()
    except Exception:
        return None


# ── psutil snapshot ──────────────────────────────────────────────────────────

def _collect():
    if not _HAS_PSUTIL:
        return {"available": False, "reason": "psutil not installed"}

    out = {"available": True}
    try:
        out["cpu_percent"] = psutil.cpu_percent(interval=None)   # since last call
        out["cpu_count"] = psutil.cpu_count(logical=True)
    except Exception:
        pass
    try:
        sw = psutil.swap_memory()
        out["swap_total"], out["swap_used"] = sw.total, sw.used
    except Exception:
        pass
    try:
        import shutil
        d = _output_dir()
        if d:
            u = shutil.disk_usage(d)
            out["disk_path"], out["disk_total"], out["disk_free"] = d, u.total, u.free
    except Exception:
        pass
    try:
        now = time.time()
        dio, nio = psutil.disk_io_counters(), psutil.net_io_counters()
        if _prev["t"] is not None:
            dt = max(now - _prev["t"], 1e-6)
            out["disk_read_bps"] = max(dio.read_bytes - _prev["disk_r"], 0) / dt
            out["disk_write_bps"] = max(dio.write_bytes - _prev["disk_w"], 0) / dt
            out["net_sent_bps"] = max(nio.bytes_sent - _prev["net_s"], 0) / dt
            out["net_recv_bps"] = max(nio.bytes_recv - _prev["net_r"], 0) / dt
        _prev.update({"t": now, "disk_r": dio.read_bytes, "disk_w": dio.write_bytes,
                      "net_s": nio.bytes_sent, "net_r": nio.bytes_recv})
    except Exception:
        pass
    return out


# ── per-run log capture ──────────────────────────────────────────────────────

class _RunLogHandler(logging.Handler):
    """
    Mirrors ComfyUI's log into the current run's file, flushing every record.

    Flushing on every line is the whole point: when ROCm aborts the process
    there is no clean shutdown, so anything still buffered is lost. The cost is
    trivial next to a diffusion step.
    """

    def __init__(self):
        super().__init__(level=logging.INFO)
        self.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        self._fh = None

    def open(self, path):
        self.close()
        try:
            self._fh = open(path, "a", encoding="utf-8", errors="replace")
        except Exception as e:
            log.warning(f"[AMDMonitor] cannot open run log: {e}")
            self._fh = None

    def close(self):
        if self._fh:
            try:
                self._fh.flush()
                self._fh.close()
            except Exception:
                pass
        self._fh = None

    def emit(self, record):
        if not self._fh:
            return
        try:
            self._fh.write(self.format(record) + "\n")
            self._fh.flush()
        except Exception:
            pass


_handler = _RunLogHandler()
_current = {"id": None, "log": None, "started": None}

try:
    logging.getLogger().addHandler(_handler)
except Exception:
    pass


def _safe(s):
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in str(s))[:40]


def _prune():
    """Keep only the newest KEEP_RUNS runs, by file mtime."""
    try:
        d = os.path.join(_base_dir(), "runs")
        files = [os.path.join(d, f) for f in os.listdir(d)]
        stems = {}
        for f in files:
            stems.setdefault(os.path.splitext(f)[0], []).append(f)
        ordered = sorted(stems.items(), key=lambda kv: os.path.getmtime(kv[1][0]),
                         reverse=True)
        for _, group in ordered[KEEP_RUNS:]:
            for f in group:
                try:
                    os.remove(f)
                except Exception:
                    pass
    except Exception:
        pass


def _run_start(prompt_id):
    stamp = time.strftime("%Y-%m-%d_%H%M%S")
    stem = os.path.join(_base_dir(), "runs", f"{stamp}_{_safe(prompt_id)}")
    _current.update({"id": prompt_id, "log": stem + ".log", "started": time.time(),
                     "stem": stem})
    _handler.open(stem + ".log")
    return stem


def _run_end(record):
    stem = _current.get("stem")
    _handler.close()
    if not stem:
        return None
    try:
        with open(stem + ".json", "w", encoding="utf-8") as fh:
            json.dump(record, fh, indent=2, default=str)
    except Exception as e:
        log.warning(f"[AMDMonitor] cannot write run record: {e}")

    # one flat row per run, easy to open in Excel
    try:
        path = os.path.join(_base_dir(), "runs.csv")
        cols = ["when", "duration_s", "result", "model", "loras", "size", "steps",
                "cfg", "sampler", "seed", "peak_vram_gb", "peak_ram_gb",
                "load_state", "sec_per_step", "slowest_node", "node_times",
                "error", "outputs", "log_file"]
        new = not os.path.exists(path)
        with open(path, "a", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
            if new:
                w.writeheader()
            w.writerow({c: record.get(c, "") for c in cols})
    except Exception as e:
        log.warning(f"[AMDMonitor] cannot append runs.csv: {e}")

    _current.update({"id": None, "log": None, "started": None, "stem": None})
    _prune()
    return stem


# ── routes ───────────────────────────────────────────────────────────────────

try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/amdmonitor/stats")
    async def _amdm_stats(request):
        return web.json_response(_collect())

    @PromptServer.instance.routes.post("/amdmonitor/run/start")
    async def _amdm_run_start(request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        stem = _run_start(body.get("prompt_id") or "run")
        return web.json_response({"ok": True, "log": os.path.basename(stem) + ".log"})

    @PromptServer.instance.routes.post("/amdmonitor/run/end")
    async def _amdm_run_end(request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        stem = _run_end(body)
        return web.json_response({"ok": True,
                                  "saved": os.path.basename(stem) if stem else None})

    @PromptServer.instance.routes.post("/amdmonitor/alert")
    async def _amdm_alert(request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        line = (f"{time.strftime('%Y-%m-%d %H:%M:%S')}\t"
                f"{body.get('level', 'warn')}\t{body.get('message', '')}\n")
        try:
            with open(os.path.join(_base_dir(), "alerts.log"), "a",
                      encoding="utf-8") as fh:
                fh.write(line)
                fh.flush()
        except Exception:
            pass
        # also into the current run's log, so the crash file explains itself
        if _current.get("log"):
            try:
                with open(_current["log"], "a", encoding="utf-8") as fh:
                    fh.write("*** AMDMonitor ALERT: " + body.get("message", "") + "\n")
                    fh.flush()
            except Exception:
                pass
        return web.json_response({"ok": True})

    @PromptServer.instance.routes.get("/amdmonitor/runs")
    async def _amdm_runs(request):
        out = []
        try:
            d = os.path.join(_base_dir(), "runs")
            files = sorted((f for f in os.listdir(d) if f.endswith(".json")),
                           reverse=True)[:KEEP_RUNS]
            for f in files:
                try:
                    with open(os.path.join(d, f), encoding="utf-8") as fh:
                        r = json.load(fh)
                        r["_file"] = f
                        out.append(r)
                except Exception:
                    pass
        except Exception:
            pass
        return web.json_response({"runs": out, "dir": _base_dir()})

    print(f"[AMDMonitor] loaded - data dir {_base_dir()}"
          + ("" if _HAS_PSUTIL else " (psutil MISSING)"))
except Exception as e:                      # pragma: no cover
    print(f"[AMDMonitor] loaded frontend only - could not register routes: {e}")
