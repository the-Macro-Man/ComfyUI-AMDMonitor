# ComfyUI-AMDMonitor

[![License: MIT](https://img.shields.io/badge/License-MIT-3da639.svg)](LICENSE)
[![Comfy Registry](https://img.shields.io/badge/Comfy%20Registry-comfyui--amdmonitor-1a73e8)](https://registry.comfy.org/nodes/comfyui-amdmonitor)
[![GPU](https://img.shields.io/badge/GPU-AMD%20%2F%20ROCm-ed1c24)](#why-nvml-based-monitors-cant-do-this)
[![Installs](https://img.shields.io/badge/extra%20installs-none-brightgreen)](#compatibility)
[![Stars](https://img.shields.io/github/stars/the-Macro-Man/ComfyUI-AMDMonitor?style=flat&color=f0b400)](https://github.com/the-Macro-Man/ComfyUI-AMDMonitor/stargazers)

**[Full documentation →](https://the-macro-man.github.io/ComfyUI-AMDMonitor/)**

VRAM monitoring, crash early-warning and per-run analytics for ComfyUI.

Most resource monitors read GPU stats through **pynvml**, which is NVIDIA-only. On an AMD
card they show CPU and RAM but never VRAM. This one reads ComfyUI's own data instead, so
it works everywhere.

> **The name says AMD; the extension doesn't care.** It works just as well on NVIDIA and
> on CPU-only setups — every source it reads is vendor-neutral, and the warnings adapt to
> the hardware they find. AMD users get VRAM figures nothing else shows them. Everyone
> gets the run history, per-node timing, crash logs and error explanations, none of which
> exist elsewhere. It's called AMD Monitor because that's the problem it was built to
> solve, not the limit of what it does.

It also keeps a record: every run's model, settings, outputs and peak usage, plus the
ComfyUI log for that run — written to disk as it happens, so it survives the crash.

No custom nodes. Nothing to install beyond the extension itself.

<img width="280" height="373" alt="image" src="https://github.com/user-attachments/assets/24f695c5-14b5-4df4-b7c2-7d6193a7a2ec" />

<img width="279" height="402" alt="image" src="https://github.com/user-attachments/assets/fdc77293-3b34-4b0d-99d0-aca6b649a569" />

<img width="281" height="404" alt="image" src="https://github.com/user-attachments/assets/03e002bc-bfb8-47fc-a208-3f25832bb3e4" />

<img width="280" height="208" alt="image" src="https://github.com/user-attachments/assets/c95ea24a-13e6-449e-b294-48d58eb53831" />

<img width="281" height="236" alt="image" src="https://github.com/user-attachments/assets/df525c37-de0d-4247-826b-2783c79ed1be" />


## Features

**GPU**

- **VRAM per GPU** — works on ROCm, multi-GPU aware
- **Peak VRAM per run** — the high-water mark, colour-coded, reset at the start of each job
- **VRAM graph** — a sparkline of the run, with guides at the warning thresholds, so you
  can see load spikes and decode plateaus
- **Integrated GPUs hidden by default** — their "VRAM" is shared system RAM and reads as
  100% for reasons that have nothing to do with ComfyUI

**System**

- **Swap** — memory spilled to disk; the reason a run suddenly crawls
- **CPU** — total load and thread count
- **Output disk free** — space left where ComfyUI writes results
- **Disk / network rates** — read/write and up/down throughput

**Run**

- **Progress + ETA** — step *k of n* with a live estimate of time remaining
- **Current node** — the executing node's real name, read from the running prompt
- **Queue depth** and **run timer**
- **Time by node** — a measured breakdown of where a run's time actually went, so a
  slow generation points at its own bottleneck
- **Seconds per step** — median, so one stall doesn't skew it
- **Run history** — model, LoRAs, size, sampler, steps, CFG, seed, outputs, errors, how
  the model loaded, and peak usage for every run. Expandable rows, CSV export, and
  written to disk as well

**Alerts**

- **Partial-load warning** — watches ComfyUI's own log and warns the instant a model
  loads partially, which on ROCm is the last thing you see before the process aborts
- **Alerts survive the crash** — critical warnings stay until dismissed, are written to
  disk, and are shown again when you restart
- **Finish notifications** — toast, desktop notification and chime with duration and peak
- **Offload warning** — fires mid-run when a GPU crosses the danger threshold

**Interface**

- **Every row has its own toggle** — 19 switches, grouped, persisted locally
- Draggable, **resizable** (drag the right edge), collapsible, remembers position and width
- **Survives restarts gracefully** — a ComfyUI restart dims the panel and says
  `Reconnecting…` rather than flashing an error

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
on its own. Use **Test Alert** to confirm sound and permissions.

### Critical alerts are different

A partial load, an out-of-memory line or a failed run produces a **sticky red card that
does not auto-dismiss**, because the abort it is warning about tends to kill the page a
few seconds later. Those alerts are also saved, so when you restart, the panel shows what
fired and when — the explanation outlives the crash.

The **H** button turns red while an alert is unread. Open it for the full list.

Alerts stand down on their own when the **next run starts** — whatever they were warning
about has either been dealt with or will re-announce itself within seconds, because the
VRAM check re-arms every run. They stay in the Alerts tab as a record; only the banner
clears. The card itself auto-hides after 10 seconds; untick **Auto-hide alerts** to keep
it until dismissed.

## Errors, explained

ComfyUI's errors are precise and unhelpful. Common ones are translated into plain
English using the context already recorded for that run — **no network, no
configuration, no AI**:

```
RuntimeError: mat1 and mat2 shapes cannot be multiplied (512x30720 and 12288x4096)
```

becomes

> **Text encoder doesn't match the model.** The conditioning has 30720 features per
> token (Krea2 (Qwen3-VL 4B)), but the model expects 12288 (flux2). Set your text
> encoder to flux2, or load the diffusion model that goes with the encoder you have.

Recognised today: text-encoder mismatch (in both the `mat1/mat2` and `normalized_shape`
phrasings), VAE/model mismatch, driver abort from a partial
load, out of memory, remote-encoder payload limit, and missing files or dropdown values.
Anything else falls through to the optional AI analysis.

## AI analysis (optional)

Off unless you configure it. There is no bundled endpoint and no default key.

Works with anything speaking the OpenAI-compatible API:

| Provider | Endpoint | Key |
|---|---|---|
| Ollama (local or LAN) | `http://192.168.1.182:11434` | none |
| LM Studio | `http://localhost:1234/v1` | none |
| OpenRouter | `https://openrouter.ai/api/v1` | required |
| OpenAI | `https://api.openai.com/v1` | required |

Set it up in **⚙ Settings → AI analysis**: paste an endpoint, press **Fetch** to list
models, pick one, **Save**.

Then in **H → Runs**, expand any row:

| Button | Where | What it does |
|---|---|---|
| **Analyse this run** | expanded row, successful runs | where the time went, memory- or compute-bound |
| **Explain this failure** | expanded row, failed runs | the cause in plain language, and the fix |
| **Compare with previous** | expanded row, when another run of the same model exists | what changed and what it cost |
| **Session summary** | bottom of the Runs tab | trends, grouped per model, failures excluded |

Recognised errors also get a built-in explanation above these buttons — no AI needed.

**The two layers cover different ground.** Built-in explanations handle seven known
patterns instantly and offline. **Explain this failure** works on *any* error, including
one nobody has seen before, because it sends the error together with the **last 60 lines
of that run's ComfyUI log** — which is usually where the cause actually sits.

**It interprets measurements, it never produces them.** Timings, VRAM and load state come
from the extension; the model only reasons about them. Its output is labelled as
interpretation and shown next to the real figures, so an invented number is obvious.

It is also told about **your** machine — GPU name and VRAM, system RAM, whether PyTorch is
a ROCm or CUDA build, the OS, and the ComfyUI launch flags actually in use. That section
is generated live, so an NVIDIA user is never told about ROCm behaviour and nobody is
advised about a flag they aren't running. The result is specific advice rather than
"consider upgrading your GPU".

### What gets sent

Model name, size, steps, sampler, CFG, LoRA names, durations, per-node timings, peak
VRAM and RAM, load state, and the error if there was one. Plus up to six previous
successful runs **of the same model**, for context.

**Prompt text is excluded** unless you tick *Include prompt text*.

**Explain this failure also sends the last 60 lines of that run's ComfyUI log.** That is
where the cause of an unfamiliar error usually sits, but log lines can contain file paths,
model paths and occasionally fragments of a prompt — *regardless of the Include prompt
text setting*, since the log is captured verbatim. On a local endpoint this stays on your
own machine. Be aware of it before pointing failure analysis at a remote provider.

A local endpoint keeps everything on your own network. A remote provider does not — the
setup panel says so plainly. The API key is stored server-side in
`user/amdmonitor/config.json` and is never sent to the browser; set
`AMDMONITOR_API_KEY` instead if you'd rather it never touched disk.

## Update checks

ComfyUI Manager only flags updates for packs installed **from the registry**. If you
track the git repo — the "nightly" channel — nothing ever tells you a new version exists,
and it's easy to sit on an old one for months.

So the panel checks for itself: one `GET` to `raw.githubusercontent.com`, **every 6 hours
by default**, result cached in `user/amdmonitor/config.json`. **Nothing about you is
sent.**

It also re-checks on that same interval while ComfyUI stays open — otherwise a session
left running for days would never notice a release, however short the cache window was.
Change the interval with `updateCheckHours` in `js/amd_monitor.js` (minimum 15 minutes).

You'll know in three places:

- a green **`v1.6.1 available`** badge beside the panel title — click it for the repository
- a one-off toast when ComfyUI loads
- the settings window header, which always shows your installed version:
  **AMD Monitor v1.6.1 settings**, with the update status and a **Check now** button
  underneath that bypasses the daily cache

Turn the network check off with **Check for updates** and the installed version is still
shown — it's read from `pyproject.toml` at runtime, so it can't drift from what you
actually have.

## Where did the time go?

Every run records a measured breakdown, taken from ComfyUI's own node-transition events
rather than inferred from log text:

```
SamplerCustomAdvanced       6:58   89%
RemoteTextEncoderSwitch      28s    6%
UNETLoader                   11s    2%
VAEDecode                     8s    2%
```

Click any row in **H → Runs** to see it. Nodes that execute more than once are summed and
marked `x2`. Seconds-per-step is reported as a **median**, so a single stall doesn't
distort the figure.

On Windows the desktop toast is labelled with the host application ("electron.app.Comfy
Desktop") and uses its icon, which the Web Notification API cannot override. The in-page
toast and alert cards carry this extension's own icon.

## Toggles

Click the **⚙ gear** — settings open in their own window, laid out in columns so the
panel stays compact. Every row is independently switchable.

| Group | Toggles |
|---|---|
| **Display** | GPU bars · Hide integrated GPU · VRAM graph · Peak VRAM · System RAM |
| **System** | Swap · CPU · Output disk free · Disk / network rates |
| **Run** | Progress + ETA · Current node · Queue depth · Run timer · Time-by-node breakdown · Save runs and logs to disk |
| **Alerts** | Notify on finish · Notify on error · Sound · Warn at high VRAM · Warn on partial model load · Auto-hide alerts · Check for updates |

**H** in the header opens run history and alerts. It turns red when there is an unread
alert. Two tabs — **Runs** and **Alerts** — each with **Export CSV**, **Clear** (that tab
only) and **Close**. Click any run row to expand its full detail.

In the settings window: **Reset Peak** clears the high-water mark and graph, **Test
Alert** fires a sample critical warning, **Defaults** restores everything.

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

This extension adds four routes of its own, all under `/amdmonitor/`:

| Route | Purpose |
|---|---|
| `GET /amdmonitor/stats` | swap, CPU, disk and network, via psutil. Read-only. |
| `POST /amdmonitor/run/start` | opens a log file for the run about to begin |
| `POST /amdmonitor/run/end` | writes the run record, appends `runs.csv`, prunes old runs |
| `POST /amdmonitor/alert` | appends to `alerts.log` and to the current run's log |
| `GET /amdmonitor/runs` | reads back saved run records |
| `GET /amdmonitor/version` | compares the installed version against the repository, at most daily |
| `GET/POST /amdmonitor/ai/config` | stores the endpoint, model and key. The key is never returned |
| `POST /amdmonitor/ai/models` | proxies the provider's `/v1/models` so the browser avoids CORS |
| `POST /amdmonitor/ai/analyse` | builds the request and calls the provider |

The three `ai/` routes do nothing until you configure an endpoint. `version` is the only
one that reaches the internet without being asked, and it can be switched off.

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

`runs.csv` has one row per run, ready for Excel:

```
when, duration_s, result, model, loras, size, steps, cfg, sampler, seed,
peak_vram_gb, peak_ram_gb, load_state, sec_per_step, slowest_node, node_times,
error, outputs, log_file
```

`load_state` is the crash-relevant one — `completely - 12.2 GB resident` or
`partially - 9.5 GB resident, 7.2 GB offloaded`.

The last 50 runs are kept; older ones are pruned (`KEEP_RUNS` in `__init__.py`). Turn the
whole thing off with the **Save runs and logs to disk** toggle, and history still works in
the browser.

## Configuration

Edit `DEFAULTS` at the top of `js/amd_monitor.js`:

| Key | Default | Meaning |
|---|---|---|
| `pollMs` | `2000` | stats poll interval, milliseconds |
| `logPollMs` | `1000` | log poll interval; faster because ComfyUI's buffer is small |
| `warnAt` | `92` | percent VRAM that triggers red and the warning |
| `alertHideSec` | `10` | how long a critical alert card stays before auto-hiding |
| `updateCheckHours` | `6` | how often to look for a new release, minimum 0.25 |

`KEEP_RUNS` in `__init__.py` (default `50`) sets how many runs are kept on disk.

## Compatibility

Works on **AMD / ROCm**, **NVIDIA / CUDA** and CPU-only setups, on Windows and Linux.
Everything it reads — ComfyUI's stats endpoint, its websocket events, its log buffer —
is vendor-neutral.

**The warnings adapt to the backend, because the hardware behaves differently.** When a
model doesn't fit, both offload weights to system RAM, but the consequence isn't the same:

| | AMD / ROCm | NVIDIA / CUDA |
|---|---|---|
| What happens | the driver usually kills the process | the run continues, slower |
| Symptom | `Fatal Python error: Aborted`, no traceback | a long render |
| How it's reported | **critical alert** — this may crash | informational — this will be slow |

Saying "CUDA may abort" would be confidently wrong, and a red alert for something routine
teaches people to switch off the warnings that matter. So the backend is detected from
PyTorch's build string and both the wording and the severity follow from it.
- Uses `psutil`, which ships with ComfyUI. If it is missing, the System rows are hidden
  and everything else still works.

If the panel doesn't appear, open the browser console (F12) and look for
`[AMDMonitor] ready`.

## Licence

MIT
