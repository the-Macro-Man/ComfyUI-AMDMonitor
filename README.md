# ComfyUI-AMDMonitor

[![License: MIT](https://img.shields.io/badge/License-MIT-3da639.svg)](LICENSE)
[![Comfy Registry](https://img.shields.io/badge/Comfy%20Registry-comfyui--amdmonitor-1a73e8)](https://registry.comfy.org/nodes/comfyui-amdmonitor)
[![GPU](https://img.shields.io/badge/GPU-AMD%20%2F%20ROCm-ed1c24)](#why-nvml-based-monitors-cant-do-this)
[![Dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)](#where-the-data-comes-from)
[![Stars](https://img.shields.io/github/stars/the-Macro-Man/ComfyUI-AMDMonitor?style=flat&color=f0b400)](https://github.com/the-Macro-Man/ComfyUI-AMDMonitor/stargazers)

VRAM monitoring and run notifications for **AMD / ROCm** GPUs in ComfyUI.

Most ComfyUI resource monitors read GPU stats through **pynvml**, which is NVIDIA-only.
On an AMD card they can show CPU and RAM but never VRAM. This extension shows VRAM,
peak usage, and tells you when your render finishes.

No Python dependencies. No custom nodes. Frontend only.

<img width="210" height="188" alt="Screenshot 2026-08-21 170800" src="https://github.com/user-attachments/assets/9ec04f92-45a6-47d5-9e28-0f4d958eca5b" />

<img width="212" height="373" alt="image" src="https://github.com/user-attachments/assets/d4debbde-d621-4065-8bc0-4093415d080a" />

## Features

**GPU**

- **VRAM per GPU** — works on ROCm, including multi-GPU and integrated Radeon graphics
- **Peak VRAM per run** — the high-water mark, colour-coded, reset at the start of each job
- **ComfyUI vs other VRAM** — how much the allocator holds versus everything else on the card
- **VRAM graph** — a sparkline of the run, so you can see load spikes and decode plateaus

**System**

- **Swap** — memory spilled to disk; the reason a run suddenly crawls
- **CPU** — total load and thread count
- **Output disk free** — space left where ComfyUI writes results
- **Disk / network rates** — read/write and up/down throughput

**Run**

- **Progress + ETA** — step *k of n* with a live estimate of time remaining
- **Current node** — which part of the graph is executing right now
- **Queue depth**, **run timer**, and **recent run history** with durations and peaks

**Alerts**

- **Finish notifications** — toast, desktop notification and chime with duration and peak
- **Failure alerts** — distinct tone plus the error message
- **Offload warning** — fires mid-run when a GPU crosses the danger threshold

**Interface**

- **Every row has its own toggle** — 18 switches, grouped, persisted locally
- Draggable, **resizable** (drag the right edge), collapsible, remembers position and width

## Install

### ComfyUI Manager

Search for **AMD Monitor** and install.

### Manual

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/the-Macro-Man/ComfyUI-AMDMonitor
```

Restart ComfyUI. A panel appears top-right.

## Why NVML-based monitors can't do this

Crystools and similar tools call `pynvml`, NVIDIA's management library. There is no
AMD equivalent it can fall back to, so the GPU section stays empty on ROCm.

ComfyUI's own `/system_stats` endpoint already reports AMD VRAM correctly, because it
goes through PyTorch's HIP backend rather than NVML. Any ComfyUI crash report on an
AMD machine shows it:

```
Name: cuda:0 AMD Radeon RX 9070 XT
VRAM Total: 17095983104
VRAM Free:  16937648128
```

The data was always there. This extension displays it.

## Peak VRAM: the number that matters

On a card without headroom, a model that doesn't fit gets **partially offloaded** to
system RAM, and ROCm then aborts the entire process:

```
loaded partially; 9008.59 MB usable, 8420.02 MB loaded, 8896.00 MB offloaded
Fatal Python error: Aborted
```

There is no traceback and no out-of-memory error — ComfyUI simply dies. Watching the
peak tells you a workflow is unsafe *before* it takes the process down.

| Bar colour | Peak | Meaning |
|---|---|---|
| green | < 80% | comfortable |
| amber | 80–92% | tight; a larger model or resolution won't fit |
| red + ⚠ | > 92% | offload risk — expect a crash |

Measured on a 16 GB RX 9070 XT (15.9 GB usable):

| Model | Size | Peak | Result |
|---|---|---|---|
| Krea2 | 12.5 GB | ~77% | works |
| Z-Image Turbo | 11.7 GB | ~74% | works |
| Flux2 Klein | 16.9 GB | — | partial load, crashes |

## Notifications

Long renders shouldn't need babysitting. On completion you get a corner toast, a
desktop notification and a short two-note chime:

```
Render finished -- 12:47 -- peak VRAM 12.2 GB
```

Desktop notifications require browser permission. **Click the ⚙ gear once** and your
browser will ask — permission can only be requested from a click, so it won't prompt
on its own. Use **test alert** to confirm sound and permissions.

## Toggles

Click the **⚙ gear**. Every row is independently switchable.

| Group | Toggles |
|---|---|
| **Display** | GPU bars · ComfyUI vs other VRAM · VRAM graph · Peak VRAM · System RAM |
| **System** | Swap · CPU · Output disk free · Disk / network rates |
| **Run** | Progress + ETA · Current node · Queue depth · Run timer · Recent runs |
| **Alerts** | Notify on finish · Notify on error · Sound · Warn at high VRAM |

Three buttons: **reset peak** clears the high-water mark and graph, **test alert** fires a
sample notification, **defaults** restores everything.

Settings, panel position and width all persist in `localStorage`.

## Where the data comes from

| Source | Provides | If unavailable |
|---|---|---|
| ComfyUI `/system_stats` | VRAM per device, system RAM | panel shows an error |
| ComfyUI websocket events | progress, current node, queue, run start/end | those rows stay empty |
| `/amdmonitor/stats` (this extension, psutil) | swap, CPU, disk, network | System rows are hidden automatically |

The psutil route is read-only. It writes nothing and executes nothing. If psutil is
missing the route still answers, reporting `available: false`, and the frontend simply
hides those rows.

## Configuration

Edit `DEFAULTS` at the top of `js/amd_monitor.js`:

| Key | Default | Meaning |
|---|---|---|
| `pollMs` | `2000` | poll interval, milliseconds |
| `warnAt` | `92` | percent VRAM that triggers red and the warning |

## Compatibility

- Works on **AMD / ROCm** on Windows and Linux.
- Also works on NVIDIA and CPU-only setups — it reads whatever ComfyUI reports.
- Requires nothing beyond ComfyUI itself.

If the panel doesn't appear, open the browser console (F12) and look for
`[AMDMonitor] ready`.

## Licence

MIT
