"""
ComfyUI-AMDMonitor
==================
VRAM / system monitor that works on AMD (ROCm) cards.

Crystools reads GPU stats through pynvml, which is NVIDIA-only, so on an AMD card
it can only ever show CPU and RAM. ComfyUI itself already reports AMD VRAM
correctly via its own /system_stats endpoint -- it goes through PyTorch's HIP
backend rather than NVML. Most of this extension is just displaying what is
already there, in the browser.

The one thing /system_stats does NOT expose is swap, CPU load, disk and network.
That is what this file adds: a single read-only route, /amdmonitor/stats, backed
by psutil. psutil ships with ComfyUI, but if it is somehow missing the route
still answers and simply reports available=False, and the frontend hides those
rows instead of breaking.

No custom nodes. Nothing is written. Nothing is executed.

Install: copy this folder into ComfyUI\\custom_nodes\\ and restart.
"""

import time

WEB_DIRECTORY = "./js"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["WEB_DIRECTORY", "NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

try:
    import psutil
    _HAS_PSUTIL = True
except Exception:
    psutil = None
    _HAS_PSUTIL = False

# Previous IO counters, so we can report rates rather than meaningless totals.
_prev = {"t": None, "disk_r": 0, "disk_w": 0, "net_s": 0, "net_r": 0}


def _output_dir():
    """Where ComfyUI writes results -- the drive whose free space actually matters."""
    try:
        import folder_paths
        return folder_paths.get_output_directory()
    except Exception:
        return None


def _collect():
    if not _HAS_PSUTIL:
        return {"available": False, "reason": "psutil not installed"}

    out = {"available": True}

    # CPU. interval=None gives usage since the previous call, which is exactly
    # what a poller wants -- passing a real interval would block the event loop.
    try:
        out["cpu_percent"] = psutil.cpu_percent(interval=None)
        out["cpu_count"] = psutil.cpu_count(logical=True)
    except Exception:
        pass

    try:
        sw = psutil.swap_memory()
        out["swap_total"] = sw.total
        out["swap_used"] = sw.used
    except Exception:
        pass

    try:
        import shutil
        d = _output_dir()
        if d:
            u = shutil.disk_usage(d)
            out["disk_path"] = d
            out["disk_total"] = u.total
            out["disk_free"] = u.free
    except Exception:
        pass

    # Rates, derived from the delta since the last poll.
    try:
        now = time.time()
        dio = psutil.disk_io_counters()
        nio = psutil.net_io_counters()
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


try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/amdmonitor/stats")
    async def _amdmonitor_stats(request):
        return web.json_response(_collect())

    print("[AMDMonitor] loaded - /system_stats for VRAM, /amdmonitor/stats for "
          "swap/cpu/disk/net" + ("" if _HAS_PSUTIL else " (psutil MISSING)"))
except Exception as e:                      # pragma: no cover
    print(f"[AMDMonitor] loaded frontend only - could not register route: {e}")
