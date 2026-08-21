"""
ComfyUI-AMDMonitor
==================
VRAM / RAM monitor that works on AMD (ROCm) cards.

Crystools reads GPU stats through pynvml, which is NVIDIA-only, so on an AMD card
it can only ever show CPU and RAM. ComfyUI itself already reports AMD VRAM
correctly via its own /system_stats endpoint -- it goes through PyTorch's HIP
backend rather than NVML. This extension just displays what is already there.

No Python dependencies, no new endpoints, no custom nodes. It is a frontend-only
extension: this file exists purely to tell ComfyUI where the JS lives.

Install: copy this folder into ComfyUI\\custom_nodes\\ and restart.
"""

WEB_DIRECTORY = "./js"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["WEB_DIRECTORY", "NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

print("[AMDMonitor] loaded - VRAM panel via /system_stats (works on ROCm)")
