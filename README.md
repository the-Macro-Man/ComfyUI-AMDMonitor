# ComfyUI-AMDMonitor

VRAM monitoring and run notifications for **AMD / ROCm** GPUs in ComfyUI.

Most ComfyUI resource monitors read GPU stats through **pynvml**, which is NVIDIA-only.
On an AMD card they can show CPU and RAM but never VRAM. This extension shows VRAM,
peak usage, and tells you when your render finishes.

No Python dependencies. No custom nodes. Frontend only.

<!-- Add a screenshot here: drag an image into the GitHub issue/README editor -->

## Features

- **VRAM per GPU** — works on ROCm, including multi-GPU and integrated Radeon graphics
- **Peak VRAM per run** — the high-water mark, colour-coded, reset at the start of each job
- **Finish notifications** — toast, desktop notification and chime with duration and peak
- **Failure alerts** — distinct tone plus the error message
- **Offload warning** — alerts mid-run when a GPU crosses the danger threshold
- **Run timer** — elapsed time, and how long the last run took
- **Everything toggleable** — eight switches behind a gear icon, persisted locally
- Draggable, collapsible, remembers its position

## Install

### ComfyUI Manager

Search for **AMD Monitor** and install.

### Manual

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/themacroman/ComfyUI-AMDMonitor
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

Click the **⚙ gear**:

| Toggle | Controls |
|---|---|
| GPU bars | per-GPU VRAM rows |
| System RAM | the RAM row |
| Peak VRAM | `peak N GB` under each GPU |
| Run timer | `running 4:12` / `last 12:47` footer |
| Notify on finish | toast + desktop notification on completion |
| Notify on error | same, for failures |
| Sound | the chime |
| Warn at high VRAM | mid-run offload-risk alert |

**reset peak** clears the high-water mark. **test alert** fires a sample notification.

Settings and panel position persist in `localStorage`.

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
