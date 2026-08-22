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

<img width="280" height="373" alt="image" src="https://github.com/user-attachments/assets/24f695c5-14b5-4df4-b7c2-7d6193a7a2ec" />

<img width="279" height="402" alt="image" src="https://github.com/user-attachments/assets/fdc77293-3b34-4b0d-99d0-aca6b649a569" />

<img width="281" height="404" alt="image" src="https://github.com/user-attachments/assets/03e002bc-bfb8-47fc-a208-3f25832bb3e4" />

<img width="280" height="208" alt="image" src="https://github.com/user-attachments/assets/c95ea24a-13e6-449e-b294-48d58eb53831" />

<img width="281" height="236" alt="image" src="https://github.com/user-attachments/assets/df525c37-de0d-4247-826b-2783c79ed1be" />


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
- **Current node** — the executing node's real name, read from the running prompt
- **Queue depth** and **run timer**
- **Run history** — model, LoRAs, size, sampler, steps, seed, outputs, errors and peak
  usage for every run. Expandable rows, CSV export, and written to disk as well

**Alerts**

- **Partial-load warning** — watches ComfyUI's own log and warns the instant a model
  loads partially, which on ROCm is the last thing you see before the process aborts
- **Alerts survive the crash** — critical warnings stay until dismissed, are written to
  disk, and are shown again when you restart
- **Finish notifications** — toast, desktop notification and chime with duration and peak
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
| **Display** | GPU bars · Hide integrated GPU · VRAM graph · Peak VRAM · System RAM |
| **System** | Swap · CPU · Output disk free · Disk / network rates |
| **Run** | Progress + ETA · Current node · Queue depth · Run timer · Save runs and logs to disk |
| **Alerts** | Notify on finish · Notify on error · Sound · Warn at high VRAM · Warn on partial model load |

**H** in the header opens run history and alerts. It turns red when there is an unread
alert. In the gear panel: **Reset Peak** clears the high-water mark and graph,
**Test Alert** fires a sample critical warning, **Defaults** restores everything.

### Why integrated GPUs are hidden by default

An iGPU's "VRAM" is carved out of system RAM, so it reads 100% red whenever system RAM
fills — even though ComfyUI never touched it. It looks like the cause of a crash when it
is only a symptom. Untick **Hide integrated GPU** if you want the row back.

Settings, panel position and width all persist in `localStorage`.

## Where the data comes from

| Source | Provides | If unavailable |
|---|---|---|
| ComfyUI `/system_stats` | VRAM per device, system RAM | shows `Reconnecting…`, keeps last values |
| ComfyUI websocket events | progress, queue, run start/end | those rows stay empty |
| ComfyUI `/queue` | the executing node's real name | falls back to `node 237` |
| ComfyUI `/internal/logs/raw` | partial-load detection | the warning is silently disabled |
| `/amdmonitor/stats` (this extension, psutil) | swap, CPU, disk, network | System rows are hidden automatically |

If psutil is missing the route still answers, reporting `available: false`, and the
frontend simply hides those rows. Nothing is ever executed.

## Where it saves things

Run records and per-run logs are written to **`ComfyUI/user/amdmonitor/`** — never the
extension folder, which ComfyUI Manager replaces on update.

```
user/amdmonitor/
  runs.csv                                one row per run
  runs/2026-08-22_1147_<promptid>.json    full record
  runs/2026-08-22_1147_<promptid>.log     ComfyUI's log for that run
  alerts.log
```

The log is **appended as the run progresses, flushed every line**. That is the whole
point: when ROCm aborts there is no clean shutdown, so anything buffered is lost. Writing
as we go leaves a file ending at the exact moment things went wrong.

The last 50 runs are kept; older ones are pruned. Turn the whole thing off with the
**Save runs and logs to disk** toggle, and history still works in the browser.

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
