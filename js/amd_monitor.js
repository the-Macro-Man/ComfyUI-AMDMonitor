import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

/*
 * AMD VRAM + system monitor, run history, and crash early-warning.
 *
 * VRAM comes from ComfyUI's own /system_stats, which reports correctly on ROCm
 * because it goes through PyTorch's HIP backend instead of NVML. Crystools
 * cannot do this because it calls pynvml directly, which is NVIDIA-only.
 *
 * The design is shaped by one failure mode: on a card without headroom ComfyUI
 * logs "loaded partially", ROCm aborts the process, and there is no traceback.
 * So warnings must survive the crash -- they are written to disk by the Python
 * side and kept in localStorage here, and the panel re-surfaces the last alert
 * after a restart. A toast that vanishes is useless when the thing it warned
 * about kills the page six seconds later.
 */

const GB = 1024 ** 3;
const LS_POS = "amdmonitor.pos";
const LS_CFG = "amdmonitor.cfg";
const LS_HIST = "amdmonitor.hist";
const LS_ALERTS = "amdmonitor.alerts";
const SPARK_N = 60;
const HIST_N = 25;
const ALERT_N = 50;
const ICON = new URL("./icon.png", import.meta.url).href;

const DEFAULTS = {
  pollMs: 2000,
  logPollMs: 1000,
  width: 216,
  showGpus: true,
  hideIgpu: true,          // integrated GPUs share system RAM -- misleading
  showSpark: true,
  showPeak: true,
  showRam: true,
  showSwap: true,
  showCpu: true,
  showDisk: true,
  showIo: false,
  showProgress: true,
  showNode: true,
  showQueue: true,
  showTimer: true,
  notifyDone: true,
  notifyError: true,
  soundDone: true,
  warnVram: true,
  warnPartial: true,
  saveToDisk: true,
  autoHideAlerts: true,
  aiSendPrompt: false,
  checkUpdates: true,
  updateCheckHours: 6,
  showNodeTimes: true,
  showPreview: false,
  warnAt: 92,
  alertHideSec: 10,
};

const load = (k, d) => {
  try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v ?? d; }
  catch (e) { return d; }
};
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

let cfg = { ...DEFAULTS, ...(load(LS_CFG, {}) || {}) };
const saveCfg = () => save(LS_CFG, cfg);
let history = load(LS_HIST, []) || [];
let alerts = load(LS_ALERTS, []) || [];

/* ── formatting ─────────────────────────────────────────────────────────── */

const fmtGB = (b) => (b / GB).toFixed(1);
const pad = (n) => String(n).padStart(2, "0");
const dur = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
};
const rate = (bps) => {
  if (!bps || bps < 1024) return "0";
  if (bps < 1024 ** 2) return (bps / 1024).toFixed(0) + " KB/s";
  return (bps / 1024 ** 2).toFixed(1) + " MB/s";
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const stamp = (t) => new Date(t).toLocaleString([],
  { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const base = (p) => String(p ?? "").split(/[\\/]/).pop();

function colour(pct) {
  if (pct >= cfg.warnAt) return "#ff4d4f";
  if (pct >= 80) return "#faad14";
  return "#52c41a";
}

/*
 * "AMD Radeon(TM) Graphics", "Intel(R) UHD Graphics" and friends are integrated
 * GPUs whose "VRAM" is carved out of system RAM. They hit 100% red whenever
 * system RAM fills, even though ComfyUI never touched them -- alarming for
 * entirely the wrong reason. Discrete cards carry a model number.
 */
const isIntegrated = (name) =>
  /\bgraphics\b/i.test(name) && !/\b(RX|RTX|GTX|Radeon Pro|Arc)\b/i.test(name);

function bar(label, used, total, extra, forceCol) {
  const pct = total > 0 ? (used / total) * 100 : 0;
  return `
    <div class="amdm-row">
      <div class="amdm-label"><span>${esc(label)}</span>
        <span class="amdm-num">${fmtGB(used)} / ${fmtGB(total)} GB</span></div>
      <div class="amdm-track"><div class="amdm-fill"
        style="width:${Math.min(pct, 100)}%;background:${forceCol || colour(pct)}"></div></div>
      <div class="amdm-sub">${pct.toFixed(0)}%${extra ? " &middot; " + extra : ""}</div>
    </div>`;
}

function sparkline(samples, w) {
  const h = 30;
  const guide = (pct) => {
    const y = (h - (pct / 100) * h).toFixed(1);
    return `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#52525b" stroke-width="1"
              stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>`;
  };
  let inner = `<rect x="0" y="0" width="${w}" height="${h}" rx="3" fill="#2a2a2e"/>
               ${guide(80)}${guide(cfg.warnAt)}`;
  if (samples.length >= 2) {
    const n = samples.length;
    const xy = samples.map((v, i) => [(i / (n - 1)) * w, h - (Math.min(v, 100) / 100) * h]);
    const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const c = colour(samples[samples.length - 1]);
    inner += `<polygon points="0,${h} ${line} ${w},${h}" fill="${c}" opacity="0.16"/>
              <polyline points="${line}" fill="none" stroke="${c}" stroke-width="1.5"
                vector-effect="non-scaling-stroke"/>`;
  }
  return `<svg class="amdm-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"
            preserveAspectRatio="none">${inner}</svg>`;
}

/* ── prompt summary ─────────────────────────────────────────────────────── */

/*
 * Pull the interesting settings out of the prompt ComfyUI is executing, so a
 * history entry can answer "what made this?" rather than just "3:03".
 */
/*
 * Resolve a value that may be a link. In API format an input is either a literal
 * or ["<node id>", <slot>]. Following one hop covers the common case of width
 * and height coming from a ResolutionMaster or a primitive; anything deeper is
 * reported as unknown rather than printed as a link tuple -- stringifying
 * ["96",0] is what produced the nonsensical "96,0x96,1" in the history.
 */
function linkNum(dict, v, want) {
  if (typeof v === "number") return v;
  if (Array.isArray(v) && v.length) {
    const n = (dict || {})[v[0]];
    const i = n?.inputs || {};
    if (typeof i[want] === "number") return i[want];
    if (typeof i.value === "number") return i.value;
  }
  return null;
}

/*
 * Built-in error explanations.
 *
 * ComfyUI's errors are precise and unhelpful. These patterns turn the common
 * ones into plain English using the context already recorded for that run. No
 * network, no configuration, no LLM -- so every user gets this, and the answers
 * are always correct rather than merely plausible. The LLM handles the long tail.
 */
const FEATURE_WIDTHS = {
  30720: "Krea2 (Qwen3-VL 4B)", 12288: "flux2", 6144: "LTX 2.5 (Gemma4 12B)",
  4096: "wan", 2560: "lumina2 / Z-Image",
};

/*
 * Backend detection, and why the wording depends on it.
 *
 * When a model doesn't fit, both backends offload weights to system RAM -- but
 * the consequence differs completely. On ROCm the process is frequently killed
 * outright ("Fatal Python error: Aborted", no traceback). On CUDA it simply runs
 * slower.
 *
 * So this is not a matter of swapping a vendor name: "CUDA may abort" would be
 * confidently wrong. The claim itself has to change, and so does the severity --
 * an emergency on one card is routine on the other, and crying wolf teaches
 * people to switch the warnings off.
 */
let BACKEND = "unknown";        // "rocm" | "cuda" | "unknown"

function detectBackend(sysinfo) {
  const v = String(sysinfo?.system?.pytorch_version || "").toLowerCase();
  if (!v) return "unknown";
  if (v.includes("rocm") || v.includes("hip")) return "rocm";
  if (v.includes("+cu")) return "cuda";
  return "unknown";
}

// Does running out of VRAM kill the process on this backend?
const aborts = () => BACKEND === "rocm";

// Clause, for use after a dash: "... reached 92% — <clause>."
function offloadConsequence() {
  if (BACKEND === "rocm")
    return "on ROCm this usually ends with the process being killed outright";
  if (BACKEND === "cuda")
    return "weights will stream from system RAM, which is far slower";
  return "further loads will spill to system RAM";
}

// Standalone sentence, for use after one that already mentions offloading.
function offloadSentence() {
  if (BACKEND === "rocm")
    return "On ROCm the driver then usually kills the process outright.";
  if (BACKEND === "cuda")
    return "The run continues, but considerably more slowly.";
  return "The run continues, but considerably more slowly.";
}

function explainError(err, rec) {
  const e = String(err || "");
  if (!e) return null;
  const model = rec?.model ? ` Your run used <code>${esc(rec.model)}</code>.` : "";

  let m = e.match(/mat1 and mat2 shapes cannot be multiplied \((\d+)x(\d+) and (\d+)x(\d+)\)/);
  if (m) {
    const got = +m[2], want = +m[3];
    const gn = FEATURE_WIDTHS[got], wn = FEATURE_WIDTHS[want];
    return { title: "Text encoder doesn't match the model", body:
      `The conditioning has <b>${got}</b> features per token${gn ? ` (${gn})` : ""}, ` +
      `but the model expects <b>${want}</b>${wn ? ` (${wn})` : ""}. ` +
      (wn ? `Set your text encoder to <b>${wn}</b>, ` : "Load the matching text encoder, ") +
      `or load the diffusion model that goes with the encoder you have.${model}` };
  }

  /*
   * The same encoder mismatch surfaces through a normalisation layer rather
   * than a matmul, and reads completely differently:
   *   Given normalized_shape=[2560], expected input with shape [*, 2560],
   *   but got input of size [1, 36, 135, 1536]
   * The width the model wants is in normalized_shape; what it got is the last
   * dimension of the actual size.
   */
  m = e.match(/normalized_shape=\[(\d+)\][\s\S]*?got input of size \[([^\]]+)\]/i);
  if (m) {
    const want = +m[1];
    const dims = m[2].split(",").map((x) => parseInt(x.trim(), 10)).filter(Number.isFinite);
    const got = dims.length ? dims[dims.length - 1] : null;
    const wn = FEATURE_WIDTHS[want], gn = got != null ? FEATURE_WIDTHS[got] : null;
    return { title: "Text encoder doesn't match the model", body:
      `The model expects conditioning <b>${want}</b> wide${wn ? ` (${wn})` : ""}, ` +
      (got != null
        ? `but the encoder produced <b>${got}</b>${gn ? ` (${gn})` : ""}. `
        : "but got something else. ") +
      (wn ? `Load the <b>${wn}</b> text encoder, ` : "Load the matching text encoder, ") +
      `or switch to the diffusion model that goes with the encoder you have.${model}` };
  }

  m = e.match(/size of tensor a \((\d+)\) must match the size of tensor b \((\d+)\)/i);
  if (m) {
    return { title: "VAE doesn't match the model", body:
      `The latent has <b>${m[1]}</b> channels but the VAE expects <b>${m[2]}</b>. ` +
      "These come from different model families — 16-channel latents are the " +
      "Flux / SD3 / Krea2 family, while video models use far more. Load the VAE " +
      `that belongs to this model in your <code>VAELoader</code>.${model}` };
  }

  // rec.load is stored as "partially - 9.5 GB resident, 7.2 GB offloaded",
  // not "loaded partially" -- matching the log phrasing here never fired.
  if (/Fatal Python error|Aborted/i.test(e) || /^partially/i.test(rec?.load || "")) {
    const pk = rec?.peak ? ` Peak VRAM reached ${(rec.peak / 1024 ** 3).toFixed(1)} GB.` : "";
    const killed = /Fatal Python error|Aborted/i.test(e);
    return {
      title: killed ? "Model too large — the process was killed"
                    : "Model too large for VRAM",
      body: "The model didn't fit, so weights were offloaded to system RAM. "
        + (killed
            ? "The driver then killed the process — there is no traceback because "
              + "it wasn't a Python error."
            : offloadSentence())
        + `${pk} Use a smaller quantisation — one that reports `
        + "<code>loaded completely</code> — or lower the resolution to free headroom." };
  }

  if (/out of memory|OutOfMemory|HIP out of memory/i.test(e)) {
    return { title: "Out of memory", body:
      "The GPU ran out of memory during the run rather than at load time, which " +
      "usually means resolution or batch size rather than the model itself. " +
      "Lower either, or close other applications using the card." };
  }

  m = e.match(/Prompt too long for '([^']+)'/);
  if (m) {
    return { title: "Prompt exceeded the remote encoder's payload limit", body:
      `The conditioning for <b>${esc(m[1])}</b> was too large to return over ` +
      "RunPod's 20 MB response limit. Shorten the prompt, or use a backend with " +
      "no cap." };
  }

  m = e.match(/not reachable at (https?:\/\/[^\s(]+)/i);
  if (m || /backend unavailable|ConnectTimeout|ConnectionError/i.test(e)) {
    const url = m ? m[1] : "the configured address";
    return { title: "Remote text encoder isn't answering", body:
      `Nothing is listening at <code>${esc(url)}</code>. The encoder service is ` +
      "usually not running — it does not start automatically after a reboot. " +
      "Start it on that machine, or switch the node's backend to <b>Auto</b> so it " +
      "falls back instead of failing." };
  }

  if (/No such file or directory|not in list|Value not in list/i.test(e)) {
    return { title: "A file or option the workflow expects is missing", body:
      "A model, LoRA or VAE named in the workflow isn't present, or a dropdown " +
      "value no longer exists on this install. Open the node named in the error " +
      "and re-pick the file." };
  }

  return null;
}

function summarise(promptDict) {
  const out = { models: [], loras: [], sampler: "", steps: "", cfg: "", seed: "",
                size: "", prompt: "", negative: "" };
  const MODEL_KEYS = ["ckpt_name", "unet_name", "model_name", "gguf_name"];
  const texts = [];
  for (const n of Object.values(promptDict || {})) {
    const ct = String(n?.class_type || ""), i = n?.inputs || {};
    if (/loader/i.test(ct)) {
      for (const k of MODEL_KEYS) {
        if (typeof i[k] === "string" && /\.(safetensors|ckpt|gguf|pt|pth|bin)$/i.test(i[k]))
          out.models.push(base(i[k]));
      }
    }
    if (/lora/i.test(ct) && typeof i.lora_name === "string") out.loras.push(base(i.lora_name));
    if (/^KSampler/.test(ct)) {
      if (i.steps != null) out.steps = i.steps;
      if (i.cfg != null) out.cfg = i.cfg;
      if (i.seed != null) out.seed = i.seed;
      if (i.sampler_name) out.sampler = i.sampler_name;
    }
    if (ct === "KSamplerSelect" && i.sampler_name) out.sampler = i.sampler_name;
    // custom-sampler graphs keep steps on the scheduler, not the sampler
    if (/Scheduler$/.test(ct) && typeof i.steps === "number") out.steps = i.steps;
    if (out.cfg === "" && typeof i.cfg === "number") out.cfg = i.cfg;
    if (out.cfg === "" && typeof i.video_cfg === "number") out.cfg = i.video_cfg;
    if (/RandomNoise/.test(ct) && i.noise_seed != null && out.seed === "")
      out.seed = i.noise_seed;
    if (/EmptyLatent|EmptySD3|EmptyLTXV/i.test(ct)) {
      const w = linkNum(promptDict, i.width, "width");
      const h = linkNum(promptDict, i.height, "height");
      if (w && h) out.size = `${w}x${h}`;
    }
    if (/CLIPTextEncode|TextEncode/i.test(ct) && typeof i.text === "string")
      texts.push(i.text);
  }
  // longest text is almost always the positive prompt; shortest the negative
  texts.sort((a, b) => b.length - a.length);
  out.prompt = (texts[0] || "").slice(0, 300);
  out.negative = (texts.length > 1 ? texts[texts.length - 1] : "").slice(0, 200);
  out.models = [...new Set(out.models)];
  out.loras = [...new Set(out.loras)];
  return out;
}

app.registerExtension({
  name: "amd.monitor",

  async setup() {
    const css = document.createElement("style");
    css.textContent = `
      #amd-monitor { position:fixed; top:8px; right:8px; z-index:1200;
        width:${cfg.width}px; min-width:180px; max-width:520px; padding:8px 10px 6px;
        font:11px/1.35 -apple-system,"Segoe UI",sans-serif; color:#e6e6e6;
        background:rgba(24,24,27,.92); border:1px solid #3f3f46; border-radius:8px;
        backdrop-filter:blur(6px); user-select:none; }
      #amd-monitor.amdm-min .amdm-body, #amd-monitor.amdm-min .amdm-cfg,
      #amd-monitor.amdm-min .amdm-lastalert { display:none; }
      #amd-monitor.amdm-stale .amdm-body { opacity:.4; }
      .amdm-head { display:flex; align-items:center; gap:6px; font-weight:600;
                   margin-bottom:6px; cursor:move; }
      .amdm-head .amdm-title { flex:1; white-space:nowrap; overflow:hidden;
                               text-overflow:ellipsis; }
      .amdm-head button { all:unset; cursor:pointer; opacity:.55; padding:0 2px;
                          font-size:12px; line-height:1; }
      .amdm-head button:hover { opacity:1; }
      .amdm-head .amdm-history { font-size:10px; font-weight:700; border:1px solid #52525b
        !important; border-radius:3px; padding:1px 4px !important; }
      .amdm-head .amdm-history.hot { border-color:#ff4d4f !important; color:#ff4d4f;
                                     opacity:1; }
      .amdm-upd { font-size:9.5px; font-weight:700; color:#0a0a0a;
        background:#52c41a; padding:1px 6px; border-radius:999px;
        margin-left:6px; cursor:pointer; vertical-align:middle; }
      .amdm-conn { margin:-2px 0 6px; font-size:10px; padding:3px 6px; border-radius:4px; }
      .amdm-conn.warn { color:#faad14; background:#faad1418; }
      .amdm-conn.bad  { color:#ff4d4f; background:#ff4d4f18; }
      .amdm-lastalert { margin:-2px 0 6px; font-size:10px; padding:5px 7px;
        border-radius:4px; color:#ff4d4f; background:#ff4d4f14;
        border:1px solid #ff4d4f44; display:flex; gap:6px; align-items:flex-start; }
      .amdm-lastalert span { flex:1; }
      .amdm-lastalert button { all:unset; cursor:pointer; opacity:.7; font-size:11px; }
      .amdm-row { margin-bottom:7px; }
      .amdm-label { display:flex; justify-content:space-between; gap:8px; margin-bottom:3px; }
      .amdm-label > span:first-child { white-space:nowrap; overflow:hidden;
                                       text-overflow:ellipsis; }
      .amdm-num { opacity:.7; font-variant-numeric:tabular-nums; white-space:nowrap; }
      .amdm-track { height:5px; background:#3f3f46; border-radius:3px; overflow:hidden; }
      .amdm-fill { height:100%; border-radius:3px; transition:width .3s, background .3s; }
      .amdm-sub { margin-top:2px; font-size:10px; opacity:.55;
                  font-variant-numeric:tabular-nums; }
      .amdm-spark { display:block; margin:1px 0 6px; }
      .amdm-warn { color:#ff4d4f; font-weight:600; opacity:1; }
      .amdm-sec { margin-top:5px; padding-top:5px; border-top:1px solid #3f3f46; }
      .amdm-kv { display:flex; justify-content:space-between; gap:8px; font-size:10.5px;
                 opacity:.8; font-variant-numeric:tabular-nums; padding:1px 0; }
      .amdm-kv b { font-weight:600; opacity:.95; }
      .amdm-prev { margin:5px 0 2px; }
      .amdm-prev img { display:block; width:100%; height:auto; border-radius:5px;
        border:1px solid #3f3f46; background:#0f0f11; }
      .amdm-prevhint { margin:5px 0 2px; font-size:10px; opacity:.45; line-height:1.35; }
      .amdm-node { font-size:10px; opacity:.7; white-space:nowrap; overflow:hidden;
                   text-overflow:ellipsis; }
      .amdm-run { color:#52c41a; }
      .amdm-grid { display:grid; gap:10px 24px;
                   grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); }
      .amdm-col h4 { margin:0 0 4px; font-size:9.5px; text-transform:uppercase;
                     letter-spacing:.06em; opacity:.45; font-weight:700; }
      .amdm-col label { display:flex; align-items:center; gap:7px; padding:3px 0;
                        cursor:pointer; font-size:11.5px; }
      .amdm-col input[type=checkbox] { accent-color:#52c41a; cursor:pointer; margin:0; }
      .amdm-btns { display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; }
      .amdm-btns button { all:unset; cursor:pointer; font-size:10px; padding:3px 7px;
        border:1px solid #52525b; border-radius:4px; opacity:.85; }
      .amdm-btns button:hover { opacity:1; border-color:#71717a; }
      .amdm-grip { position:absolute; top:0; right:0; width:7px; height:100%;
                   cursor:ew-resize; }
      .amdm-grip:hover { background:linear-gradient(90deg,transparent,#52c41a44); }
      #amdm-toast { position:fixed; bottom:16px; right:16px; z-index:1300; max-width:320px;
        padding:9px 13px; font:12px/1.4 "Segoe UI",sans-serif; color:#e6e6e6;
        background:rgba(24,24,27,.96); border-left:3px solid #52c41a; border-radius:6px;
        opacity:0; transform:translateY(8px); transition:opacity .25s, transform .25s;
        pointer-events:none; display:flex; align-items:center; gap:10px; }
      #amdm-toast img { width:26px; height:26px; flex:0 0 26px; border-radius:5px; }
      #amdm-toast.amdm-show { opacity:1; transform:translateY(0); }
      #amdm-sticky { position:fixed; bottom:16px; right:16px; z-index:1310; max-width:360px;
        display:flex; flex-direction:column; gap:8px; }
      #amdm-sticky .amdm-crit { display:flex; gap:10px; align-items:flex-start;
        padding:11px 13px; font:12px/1.45 "Segoe UI",sans-serif; color:#e6e6e6;
        background:#2a1416; border:1px solid #ff4d4f66; border-left:3px solid #ff4d4f;
        border-radius:6px; box-shadow:0 6px 20px #0008; }
      #amdm-sticky img { width:26px; height:26px; flex:0 0 26px; border-radius:5px; }
      #amdm-sticky b { display:block; color:#ff4d4f; margin-bottom:2px; }
      #amdm-sticky button { all:unset; cursor:pointer; opacity:.6; font-size:14px;
                            line-height:1; }
      #amdm-sticky button:hover { opacity:1; }
      #amdm-modal { position:fixed; inset:0; z-index:1400; display:flex;
        align-items:center; justify-content:center; background:rgba(0,0,0,.55); }
      #amdm-modal .amdm-card { width:min(680px,94vw); max-height:82vh; overflow:auto;
        background:#18181b; border:1px solid #3f3f46; border-radius:10px; padding:16px 18px;
        font:12px/1.45 "Segoe UI",sans-serif; color:#e6e6e6; }
      #amdm-modal h3 { margin:0 0 10px; font-size:14px; display:flex; gap:10px;
                       align-items:center; }
      #amdm-modal .amdm-tab { all:unset; cursor:pointer; font-size:11px; padding:3px 9px;
        border:1px solid #3f3f46; border-radius:999px; opacity:.6; }
      #amdm-modal .amdm-tab.on { opacity:1; border-color:#52c41a; color:#52c41a; }
      #amdm-modal table { width:100%; border-collapse:collapse;
                          font-variant-numeric:tabular-nums; }
      #amdm-modal th { text-align:left; font-size:10px; text-transform:uppercase;
        letter-spacing:.05em; opacity:.5; padding:4px 6px; border-bottom:1px solid #3f3f46; }
      #amdm-modal td { padding:4px 6px; border-bottom:1px solid #27272a; font-size:11.5px;
                       vertical-align:top; }
      #amdm-modal tr.bad td { color:#ff8b8c; }
      #amdm-modal .amdm-exp { margin-top:8px; padding:10px 12px; border-radius:6px;
        background:#4c9aff12; border-left:3px solid #4c9aff; font-size:11.5px; }
      #amdm-modal .amdm-exp b { display:block; color:#e6e6e6; margin-bottom:3px; }
      #amdm-modal .amdm-ai { margin-top:8px; padding:10px 12px; border-radius:6px;
        background:#52c41a10; border-left:3px solid #52c41a; font-size:11.5px;
        white-space:normal; }
      #amdm-modal .amdm-aif { margin-top:6px; font-size:10px; opacity:.45; }
      #amdm-modal .amdm-aibtns { margin-top:8px; }
      #amdm-modal .amdm-ai-cfg { margin-top:16px; padding-top:14px;
        border-top:1px solid #3f3f46; }
      #amdm-modal .amdm-ai-cfg h4 { margin:0 0 2px; font-size:11px; text-transform:uppercase;
        letter-spacing:.06em; opacity:.6; }
      #amdm-modal .amdm-hint { font-size:10.5px; opacity:.5; margin:0 0 8px; }
      #amdm-modal .amdm-ver { display:flex; align-items:center; gap:10px; font-size:11px;
        opacity:.7; margin:-4px 0 14px; padding-bottom:12px;
        border-bottom:1px solid #27272a; }
      #amdm-modal .amdm-ver button { all:unset; cursor:pointer; font-size:10px;
        padding:2px 8px; border:1px solid #52525b; border-radius:4px; }
      #amdm-modal .amdm-ver button:hover { border-color:#71717a; }
      #amdm-modal .amdm-updline { color:#52c41a; opacity:1; }
      #amdm-modal .amdm-updline a { color:#4c9aff; margin-left:6px; }
      #amdm-modal .amdm-f { display:flex; align-items:center; gap:10px; margin:5px 0;
        font-size:11.5px; }
      #amdm-modal .amdm-f > span:first-child { flex:0 0 74px; opacity:.6; }
      #amdm-modal .amdm-f input[type=text], #amdm-modal .amdm-f input[type=password] {
        flex:1; background:#0f0f11; border:1px solid #3f3f46; border-radius:5px;
        color:#e6e6e6; padding:5px 8px; font:inherit; font-size:11.5px; }
      #amdm-modal .amdm-f input:focus { outline:none; border-color:#52c41a; }

      #amdm-modal tr.row { cursor:pointer; }
      #amdm-modal tr.row:hover td { background:#ffffff08; }
      #amdm-modal .amdm-detail td { font-size:11px; opacity:.85; background:#ffffff05; }
      #amdm-modal .amdm-detail div { padding:2px 0; }
      #amdm-modal .amdm-detail .k { display:inline-block; min-width:78px; opacity:.5;
                                    vertical-align:top; }
      #amdm-modal .amdm-nt { margin-top:6px; padding-top:6px; border-top:1px solid #27272a; }
      #amdm-modal .amdm-ntrow { display:flex; align-items:center; gap:8px; padding:1px 0;
                                margin-left:78px; }
      #amdm-modal .amdm-ntname { flex:0 0 42%; white-space:nowrap; overflow:hidden;
                                 text-overflow:ellipsis; }
      #amdm-modal .amdm-ntbar { flex:1; height:5px; background:#3f3f46; border-radius:3px;
                                overflow:hidden; }
      #amdm-modal .amdm-ntbar i { display:block; height:100%; background:#52c41a; }
      #amdm-modal .amdm-ntval { flex:0 0 78px; text-align:right; opacity:.7;
                                font-variant-numeric:tabular-nums; }
      #amdm-modal .amdm-path { font-size:10.5px; opacity:.45; margin-top:10px;
                               word-break:break-all; }
    `;
    document.head.appendChild(css);

    const SECTIONS = [
      ["Display", [
        ["showGpus", "GPU bars"], ["hideIgpu", "Hide integrated GPU"],
        ["showSpark", "VRAM graph"], ["showPeak", "Peak VRAM"], ["showRam", "System RAM"],
      ]],
      ["System (needs psutil route)", [
        ["showSwap", "Swap"], ["showCpu", "CPU"],
        ["showDisk", "Output disk free"], ["showIo", "Disk / network rates"],
      ]],
      ["Run", [
        ["showProgress", "Progress + ETA"], ["showNode", "Current node"],
        ["showQueue", "Queue depth"], ["showTimer", "Run timer"],
        ["showNodeTimes", "Time-by-node breakdown"],
        ["showPreview", "Live preview while rendering"],
        ["saveToDisk", "Save runs and logs to disk"],
      ]],
      ["Alerts", [
        ["notifyDone", "Notify on finish"], ["notifyError", "Notify on error"],
        ["soundDone", "Sound"], ["warnVram", "Warn at high VRAM"],
        ["warnPartial", "Warn on partial model load"],
        ["autoHideAlerts", `Auto-hide alerts after ${DEFAULTS.alertHideSec}s`],
        ["checkUpdates", "Check for updates"],
      ]],
    ];

    const box = document.createElement("div");
    box.id = "amd-monitor";
    box.innerHTML = `
      <div class="amdm-grip" title="drag to resize"></div>
      <div class="amdm-head">
        <span class="amdm-title">GPU / System</span>
        <button class="amdm-history" title="Run history and alerts">H</button>
        <button class="amdm-gear" title="Settings">&#9881;</button>
        <button class="amdm-fold" title="Collapse">&#9662;</button>
      </div>
      <div class="amdm-conn" style="display:none"></div>
      <div class="amdm-lastalert" style="display:none"><span></span><button
        title="Dismiss">&times;</button></div>
      <div class="amdm-body">connecting&hellip;</div>`;
    document.body.appendChild(box);

    const bodyEl = box.querySelector(".amdm-body");
    const connEl = box.querySelector(".amdm-conn");
    const alertEl = box.querySelector(".amdm-lastalert");
    const histBtn = box.querySelector(".amdm-history");

    const p = load(LS_POS, null);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      box.style.left = p.x + "px"; box.style.top = p.y + "px"; box.style.right = "auto";
    }

    /* ── alerts ───────────────────────────────────────────────────────── */

    let stickyEl = null;
    function sticky(title, message) {
      if (!stickyEl) {
        stickyEl = document.createElement("div");
        stickyEl.id = "amdm-sticky";
        document.body.appendChild(stickyEl);
      }
      const card = document.createElement("div");
      card.className = "amdm-crit";
      card.innerHTML = `<img src="${ICON}" alt="">
        <div style="flex:1"><b>${esc(title)}</b>${esc(message)}</div>
        <button title="Dismiss">&times;</button>`;
      card.querySelector("button").onclick = () => card.remove();
      stickyEl.appendChild(card);
      // The card is only one of three surfaces -- the panel banner, the Alerts
      // tab and alerts.log all keep the record -- so hiding it loses nothing.
      if (cfg.autoHideAlerts) {
        setTimeout(() => card.remove(), Math.max(2, cfg.alertHideSec) * 1000);
      }
    }

    function pushAlert(title, message) {
      alerts.unshift({ at: Date.now(), title, message, ack: false });
      alerts = alerts.slice(0, ALERT_N);
      save(LS_ALERTS, alerts);
      // Critical alerts do NOT auto-dismiss: a ROCm abort kills the page seconds
      // later, so a 6-second toast is gone before it can be read.
      sticky(title, message);
      beep(false);
      renderLastAlert();
      if (cfg.saveToDisk) {
        api.fetchApi("/amdmonitor/alert", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ level: "critical", message: `${title}: ${message}` }),
        }).catch(() => {});
      }
      if ("Notification" in window && Notification.permission === "granted") {
        try { new Notification(title, { body: message, icon: ICON }); } catch (e) {}
      }
    }

    function renderLastAlert() {
      const un = alerts.find((a) => !a.ack);
      histBtn.classList.toggle("hot", !!un);
      if (!un) { alertEl.style.display = "none"; return; }
      alertEl.style.display = "";
      alertEl.querySelector("span").innerHTML =
        `<b>${esc(un.title)}</b> &middot; ${stamp(un.at)}<br>${esc(un.message)}`;
    }
    alertEl.querySelector("button").onclick = () => {
      alerts.forEach((a) => (a.ack = true));
      save(LS_ALERTS, alerts); renderLastAlert();
    };
    renderLastAlert();   // survives the crash: shown again on reload

    /* ── transient toast ──────────────────────────────────────────────── */

    let toastEl = null, toastMsg = null;
    function toast(text, ok = true) {
      if (!toastEl) {
        toastEl = document.createElement("div");
        toastEl.id = "amdm-toast";
        toastEl.innerHTML = `<img src="${ICON}" alt=""><span></span>`;
        document.body.appendChild(toastEl);
        toastMsg = toastEl.querySelector("span");
      }
      toastMsg.textContent = text;
      toastEl.style.borderLeftColor = ok ? "#52c41a" : "#ff4d4f";
      toastEl.classList.add("amdm-show");
      clearTimeout(toastEl._t);
      toastEl._t = setTimeout(() => toastEl.classList.remove("amdm-show"), 6000);
    }

    function beep(ok = true) {
      if (!cfg.soundDone) return;
      try {
        const ac = new (window.AudioContext || window.webkitAudioContext)();
        (ok ? [660, 880] : [440, 330]).forEach((f, i) => {
          const o = ac.createOscillator(), g = ac.createGain();
          o.type = "sine"; o.frequency.value = f;
          const t0 = ac.currentTime + i * 0.16;
          g.gain.setValueAtTime(0.0001, t0);
          g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15);
          o.connect(g).connect(ac.destination);
          o.start(t0); o.stop(t0 + 0.16);
        });
      } catch (e) {}
    }

    function notify(title, body, ok = true) {
      toast(title + (body ? " -- " + body : ""), ok);
      if ("Notification" in window && Notification.permission === "granted") {
        try { new Notification(title, { body, tag: "amdmonitor", icon: ICON }); }
        catch (e) {}
      }
    }

    /* ── optional AI analysis ─────────────────────────────────────────── */

    const AI = { base: "", model: "", has_key: false, env_key: false, models: [] };
    const VER = { installed: "", latest: "", update: false, checked_at: 0, url: "" };

    const aiLoadConfig = () => api.fetchApi("/amdmonitor/ai/config")
      .then((r) => r.json()).then((j) => Object.assign(AI, j)).catch(() => {});

    /*
     * Only measured facts go to the model. Prompt text is excluded unless the
     * user opts in -- it is the one field that is genuinely personal, and the
     * analysis works fine without it.
     */
    function runFacts(h) {
      const f = {
        model: h.model, size: h.size, steps: h.steps, cfg: h.cfg,
        sampler: h.sampler, duration_s: Math.round(h.dur / 1000),
        sec_per_step: h.sps || null,
        peak_vram_gb: h.peak ? +(h.peak / GB).toFixed(2) : null,
        peak_ram_gb: h.peakRam ? +(h.peakRam / GB).toFixed(2) : null,
        load_state: h.load || null, result: h.result,
        loras: h.loras || null,
        node_seconds: (h.nodes || []).reduce(
          (o, t) => (o[t.label] = +(t.ms / 1000).toFixed(1), o), {}),
      };
      if (h.result !== "ok" && h.error) f.error = h.error;
      if (cfg.aiSendPrompt && h.prompt) f.prompt = h.prompt;
      return f;
    }

    async function aiAsk(kind, h, into) {
      if (!AI.base) { into.innerHTML = `<span class="amdm-warn">No endpoint configured — set one in Settings.</span>`; return; }
      into.textContent = "Thinking…";
      // same-model peers only: seconds-per-step is meaningless across models
      const peers = history.filter((x) => x.model === h.model && x.result === "ok")
                           .slice(0, 6).map(runFacts);
      let ask;
      if (kind === "explain") {
        ask = "This ComfyUI run failed. Explain the cause in plain language and give "
            + "the fix.\n\n" + JSON.stringify(runFacts(h), null, 1);
      } else if (kind === "compare") {
        // the immediately previous successful run of the SAME model
        const prev = peers.find((p) => p.duration_s !== runFacts(h).duration_s) || peers[0];
        ask = "Compare these two runs of the same model. State what changed, what it "
            + "cost, and whether the difference is explained by the settings.\n\n"
            + `THIS RUN:\n${JSON.stringify(runFacts(h), null, 1)}\n\n`
            + `PREVIOUS RUN:\n${JSON.stringify(prev, null, 1)}`;
      } else if (kind === "session") {
        // grouped per model: seconds-per-step is not comparable across models
        const groups = {};
        for (const r of history) {
          if (r.result !== "ok") continue;
          (groups[r.model || "unknown"] ||= []).push(runFacts(r));
        }
        ask = "Summarise this session. Report per model, never mixing them. Point out "
            + "anything actionable.\n\n"
            + Object.entries(groups).map(([k, v]) =>
                `MODEL ${k} (${v.length} run${v.length > 1 ? "s" : ""}):\n`
                + JSON.stringify(v.slice(0, 8), null, 1)).join("\n\n")
            + `\n\n(${history.filter((r) => r.result !== "ok").length} failed run(s) `
            + "excluded from these figures.)";
      } else {
        ask = "Analyse this run. Where did the time go, and is it memory- or "
            + "compute-bound?\n\n"
            + `THIS RUN:\n${JSON.stringify(runFacts(h), null, 1)}\n\n`
            + (peers.length > 1
                ? `PREVIOUS SUCCESSFUL RUNS OF THE SAME MODEL (${peers.length}):\n`
                  + JSON.stringify(peers, null, 1)
                : "No other successful runs of this model are recorded, so do not "
                  + "infer trends.");
      }
      try {
        const r = await api.fetchApi("/amdmonitor/ai/analyse", {
          method: "POST", headers: { "Content-Type": "application/json" },
          // sys is the live /system_stats payload -- the backend builds the
          // hardware section of the system prompt from it, so the advice suits
          // whatever machine this actually is
          body: JSON.stringify({ base: AI.base, model: AI.model, prompt: ask,
                                 machine: sys,
                                 // the backend appends this run's log tail, which
                                 // is where the cause of an unfamiliar error lives
                                 log_file: kind === "explain" ? h.log_file : null }),
        });
        const j = await r.json();
        if (j.error) { into.innerHTML = `<span class="amdm-warn">${esc(j.error)}</span>`; return; }
        h.analysis = j.text;
        save(LS_HIST, history);
        into.innerHTML = `<div class="amdm-ai">${esc(j.text).replace(/\n/g, "<br>")}
          <div class="amdm-aif">${esc(j.model)} · interpretation only — the figures above are measured</div></div>`;
      } catch (e) {
        into.innerHTML = `<span class="amdm-warn">${esc(String(e))}</span>`;
      }
    }

    /* ── history modal ────────────────────────────────────────────────── */

    let dataDir = "";
    function showHistory(tab = "runs") {
      document.getElementById("amdm-modal")?.remove();
      const m = document.createElement("div");
      m.id = "amdm-modal";

      const runRows = history.length ? history.map((h, idx) => `
        <tr class="row ${h.result === "ok" ? "" : "bad"}" data-i="${idx}">
          <td>${esc(stamp(h.at))}</td>
          <td>${esc(h.model || "&mdash;")}</td>
          <td>${dur(h.dur)}</td>
          <td>${h.peak ? fmtGB(h.peak) + " GB" : "&mdash;"}</td>
          <td>${h.result === "ok" ? "ok" : "failed"}</td>
        </tr>
        <tr class="amdm-detail" data-d="${idx}" style="display:none"><td colspan="5">
          ${[["Model", h.model], ["LoRAs", h.loras], ["Size", h.size],
             ["Sampler", h.sampler], ["Steps", h.steps], ["CFG", h.cfg],
             ["Seed", h.seed], ["Load", h.load],
             ["Sec / step", h.sps ? h.sps + " s" : ""],
             ["Peak RAM", h.peakRam ? fmtGB(h.peakRam) + " GB" : ""],
             ["Outputs", h.outputs], ["Log", h.log_file],
             ["Error", h.error], ["Prompt", h.prompt]]
            .filter(([, v]) => v !== undefined && v !== null && v !== "")
            .map(([k, v]) => `<div><span class="k">${k}</span>${esc(v)}</div>`).join("")}
          ${cfg.showNodeTimes && (h.nodes || []).length ? `
            <div class="amdm-nt"><span class="k">Time by node</span>
              ${h.nodes.map((t) => {
                  const pc = h.dur ? (t.ms / h.dur) * 100 : 0;
                  return `<div class="amdm-ntrow">
                    <span class="amdm-ntname">${esc(t.label)}${t.n > 1 ? ` x${t.n}` : ""}</span>
                    <span class="amdm-ntbar"><i style="width:${Math.min(pc, 100).toFixed(1)}%"></i></span>
                    <span class="amdm-ntval">${dur(t.ms)}  ${pc.toFixed(0)}%</span>
                  </div>`;
                }).join("")}
            </div>` : ""}
          ${(() => { const x = explainError(h.error, h);
            return x ? `<div class="amdm-exp"><b>${x.title}</b>${x.body}</div>` : ""; })()}
          <div class="amdm-btns amdm-aibtns" data-r="${idx}">
            ${h.result !== "ok"
              ? `<button data-ai="explain" data-i="${idx}">Explain this failure</button>`
              : `<button data-ai="analyse" data-i="${idx}">Analyse this run</button>`}
            ${history.some((x, j) => j !== idx && x.model === h.model && x.result === "ok")
              ? `<button data-ai="compare" data-i="${idx}">Compare with previous</button>` : ""}
          </div>
          <div class="amdm-aiout" data-o="${idx}">${
            h.analysis ? `<div class="amdm-ai">${esc(h.analysis).replace(/\n/g, "<br>")}</div>` : ""}</div>
        </td></tr>`).join("")
        : `<tr><td colspan="5" style="opacity:.5;padding:14px 6px">
             No runs recorded yet.</td></tr>`;

      const alertRows = alerts.length ? alerts.map((a) => `
        <tr class="bad"><td>${esc(stamp(a.at))}</td><td>${esc(a.title)}</td>
          <td>${esc(a.message)}</td></tr>`).join("")
        : `<tr><td colspan="3" style="opacity:.5;padding:14px 6px">
             No alerts recorded.</td></tr>`;

      m.innerHTML = `
        <div class="amdm-card">
          <h3>AMD Monitor
            <button class="amdm-tab ${tab === "runs" ? "on" : ""}" data-t="runs">Runs</button>
            <button class="amdm-tab ${tab === "alerts" ? "on" : ""}" data-t="alerts">
              Alerts${alerts.length ? " (" + alerts.length + ")" : ""}</button>
          </h3>
          ${tab === "runs" ? `<table>
            <thead><tr><th>When</th><th>Model</th><th>Duration</th><th>Peak VRAM</th>
              <th>Result</th></tr></thead><tbody>${runRows}</tbody></table>
            <div style="font-size:10.5px;opacity:.45;margin-top:6px">
              Click a row for full details.</div>`
          : `<table><thead><tr><th>When</th><th>Alert</th><th>Detail</th></tr></thead>
             <tbody>${alertRows}</tbody></table>`}
          <div class="amdm-aiout" data-o="session"></div>
          <div class="amdm-btns">
            ${tab === "runs" && history.length
              ? `<button class="amdm-session">Session summary</button>` : ""}
            <button class="amdm-csv">Export CSV</button>
            <button class="amdm-clear">Clear ${tab}</button>
            <button class="amdm-close">Close</button>
          </div>
          ${dataDir ? `<div class="amdm-path">Runs and logs are also written to
            ${esc(dataDir)}</div>` : ""}
        </div>`;
      document.body.appendChild(m);

      m.onclick = (e) => { if (e.target === m) m.remove(); };
      m.querySelectorAll(".amdm-tab").forEach((b) =>
        (b.onclick = () => showHistory(b.dataset.t)));
      m.querySelector(".amdm-close").onclick = () => m.remove();
      m.querySelectorAll("tr.row").forEach((tr) => (tr.onclick = () => {
        const d = m.querySelector(`tr.amdm-detail[data-d="${tr.dataset.i}"]`);
        if (d) d.style.display = d.style.display === "none" ? "" : "none";
      }));
      const sessBtn = m.querySelector(".amdm-session");
      if (sessBtn) sessBtn.onclick = () =>
        aiAsk("session", history[0], m.querySelector('.amdm-aiout[data-o="session"]'));
      m.querySelectorAll("button[data-ai]").forEach((b) => (b.onclick = (ev) => {
        ev.stopPropagation();
        const i = +b.dataset.i;
        aiAsk(b.dataset.ai, history[i], m.querySelector(`.amdm-aiout[data-o="${i}"]`));
      }));
      m.querySelector(".amdm-clear").onclick = () => {
        if (tab === "runs") { history = []; save(LS_HIST, history); }
        else { alerts = []; save(LS_ALERTS, alerts); renderLastAlert(); }
        showHistory(tab);
      };
      m.querySelector(".amdm-csv").onclick = () => {
        let csv;
        if (tab === "runs") {
          csv = "when,model,loras,size,steps,sampler,seed,duration_s,peak_vram_gb,result,error\n"
            + history.map((h) => [new Date(h.at).toISOString(), h.model, h.loras, h.size,
                h.steps, h.sampler, h.seed, Math.round(h.dur / 1000),
                h.peak ? (h.peak / GB).toFixed(2) : "", h.result, h.error]
                .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
        } else {
          csv = "when,alert,detail\n" + alerts.map((a) =>
            [new Date(a.at).toISOString(), a.title, a.message]
              .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
        }
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
        a.download = `amdmonitor_${tab}.csv`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      };
    }

    /* ── settings modal ───────────────────────────────────────────────── */

    /*
     * Settings open in a modal rather than expanding the panel. Nineteen
     * toggles in a single column made the panel taller than the screen, so the
     * sections are laid out in an auto-fitting grid instead.
     */
    function showSettings() {
      document.getElementById("amdm-modal")?.remove();
      const m = document.createElement("div");
      m.id = "amdm-modal";
      m.innerHTML = `
        <div class="amdm-card">
          <h3>AMD Monitor${VER.installed ? ` <span style="font-weight:400;opacity:.5">v${
            esc(VER.installed)}</span>` : ""} settings</h3>
          <div class="amdm-ver">${
            VER.update
              ? `<span class="amdm-updline"><b>v${esc(VER.latest)} is available.</b>
                   <a href="${esc(VER.url)}" target="_blank">Open the repository</a></span>`
              : VER.latest
                ? `Up to date${VER.checked_at ? " — last checked " +
                    stamp(VER.checked_at * 1000) : ""}.`
                : cfg.checkUpdates ? "Update status unknown." : "Update checks are off."}
            <button class="amdm-vercheck">Check now</button>
          </div>
          <div class="amdm-grid">
            ${SECTIONS.map(([n, items]) => `<div class="amdm-col">
                <h4>${esc(n)}</h4>
                ${items.map(([k, l]) => `<label><input type="checkbox" data-k="${k}"${
                  cfg[k] ? " checked" : ""}> ${esc(l)}</label>`).join("")}
              </div>`).join("")}
          </div>
          <div class="amdm-ai-cfg">
            <h4>AI analysis <span style="opacity:.5;font-weight:400">optional</span></h4>
            <p class="amdm-hint">Leave the endpoint blank to disable. Built-in error
              explanations work regardless and never use the network.</p>
            <label class="amdm-f"><span>Endpoint</span>
              <input class="amdm-base" type="text" spellcheck="false"
                placeholder="http://192.168.1.182:11434  ·  https://openrouter.ai/api/v1"
                value="${esc(AI.base)}"></label>
            <label class="amdm-f"><span>API key</span>
              <input class="amdm-key" type="password" spellcheck="false"
                placeholder="${AI.env_key ? "set via AMDMONITOR_API_KEY"
                  : AI.has_key ? "stored — leave blank to keep" : "not needed for local Ollama"}"
                ${AI.env_key ? "disabled" : ""}></label>
            <label class="amdm-f"><span>Model</span>
              <span style="display:flex;gap:6px;flex:1">
                <input class="amdm-model" type="text" spellcheck="false" list="amdm-models"
                  placeholder="qwen3.5:9b" value="${esc(AI.model)}" style="flex:1">
                <datalist id="amdm-models">${AI.models.map(
                  (x) => `<option value="${esc(x)}">`).join("")}</datalist>
                <button class="amdm-fetch" style="all:unset;cursor:pointer;font-size:10px;
                  padding:3px 7px;border:1px solid #52525b;border-radius:4px">Fetch</button>
              </span></label>
            <label class="amdm-f"><span></span><span style="flex:1;font-size:10.5px">
              <input type="checkbox" data-k="aiSendPrompt"${cfg.aiSendPrompt ? " checked" : ""}
                style="accent-color:#52c41a;margin-right:6px">Include prompt text
              </span></label>
            <div class="amdm-hint amdm-aistatus"></div>
          </div>
          <div class="amdm-btns">
            <button class="amdm-save">Save</button>
            <button class="amdm-reset">Reset Peak</button>
            <button class="amdm-test">Test Alert</button>
            <button class="amdm-defaults">Defaults</button>
            <button class="amdm-close">Close</button>
          </div>
        </div>`;
      document.body.appendChild(m);
      m.onclick = (e) => { if (e.target === m) m.remove(); };
      m.querySelector(".amdm-close").onclick = () => m.remove();

      m.querySelector(".amdm-vercheck").onclick = async (e) => {
        e.target.textContent = "Checking…";
        const prev = cfg.checkUpdates;
        cfg.checkUpdates = true;            // an explicit click is consent enough
        await loadVersion(true);
        cfg.checkUpdates = prev;
        showSettings();                     // redraw with the fresh result
      };

      const status = m.querySelector(".amdm-aistatus");
      const readForm = () => ({
        base: m.querySelector(".amdm-base").value.trim(),
        model: m.querySelector(".amdm-model").value.trim(),
        key: m.querySelector(".amdm-key").value,
      });
      m.querySelector(".amdm-save").onclick = async () => {
        const f = readForm();
        const r = await api.fetchApi("/amdmonitor/ai/config", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(f),
        }).then((x) => x.json()).catch(() => ({}));
        Object.assign(AI, { base: f.base, model: f.model, has_key: !!r.has_key });
        m.querySelector(".amdm-key").value = "";
        status.textContent = f.base ? "Saved." : "Saved — AI analysis disabled.";
      };
      m.querySelector(".amdm-fetch").onclick = async () => {
        const f = readForm();
        if (!f.base) { status.textContent = "Enter an endpoint first."; return; }
        status.textContent = "Fetching models…";
        const r = await api.fetchApi("/amdmonitor/ai/models", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ base: f.base }),
        }).then((x) => x.json()).catch((e) => ({ error: String(e) }));
        if (r.error) { status.innerHTML = `<span class="amdm-warn">${esc(r.error)}</span>`; return; }
        AI.models = r.models || [];
        m.querySelector("#amdm-models").innerHTML =
          AI.models.map((x) => `<option value="${esc(x)}">`).join("");
        status.textContent = `${AI.models.length} model(s) available — start typing to filter.`;
      };
      m.querySelectorAll("input[type=checkbox]").forEach((el) => {
        el.onchange = () => {
          cfg[el.dataset.k] = el.checked;
          if (el.dataset.k === "showPreview" && !el.checked) dropPreview();
          saveCfg(); render();
        };
      });
      m.querySelector(".amdm-reset").onclick = () => {
        peak = {}; peakRam = 0; spark = []; toast("Peak and graph reset");
      };
      m.querySelector(".amdm-test").onclick = () =>
        pushAlert("Test alert", "This is what a critical warning looks like. It stays "
          + "until you dismiss it, and survives a restart.");
      m.querySelector(".amdm-defaults").onclick = () => {
        cfg = { ...DEFAULTS }; saveCfg();
        box.style.width = cfg.width + "px";
        render(); showSettings(); toast("Settings reset to defaults");
      };
    }

    histBtn.onclick = () => showHistory("runs");
    box.querySelector(".amdm-fold").onclick = () => box.classList.toggle("amdm-min");
    box.querySelector(".amdm-gear").onclick = () => {
      showSettings();
      if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();   // only allowed from a user gesture
      }
    };

    /* ── state ────────────────────────────────────────────────────────── */

    let peak = {}, peakRam = 0, spark = [];
    let sys = null, extra = null;
    let running = false, runStart = null, lastRun = null, warned = false;
    let progress = null, curNode = null, queue = 0;
    let nodeNames = {}, meta = null, outputs = [], runErr = "", logFile = "";
    let conn = "ok", fails = 0;
    // per-node timing, measured from ComfyUI's own `executing` transitions
    let nodeTimes = [], nodeStart = null, lastNode = null;
    let stepTimes = [], lastStep = null, loadInfo = "";
    // live preview: the object URL currently on screen, and whether any frame
    // has ever arrived (used to tell "previews are off" from "not started yet")
    let previewUrl = null, previewSeen = false;

    /* ── drag / resize ────────────────────────────────────────────────── */

    let mx = 0, my = 0, moving = false, rx = 0, rw = 0, sizing = false;
    box.querySelector(".amdm-head").addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      moving = true; mx = e.clientX - box.offsetLeft; my = e.clientY - box.offsetTop;
      e.preventDefault();
    });
    box.querySelector(".amdm-grip").addEventListener("mousedown", (e) => {
      sizing = true; rx = e.clientX; rw = box.offsetWidth;
      e.preventDefault(); e.stopPropagation();
    });
    window.addEventListener("mousemove", (e) => {
      if (moving) {
        box.style.left = (e.clientX - mx) + "px";
        box.style.top = (e.clientY - my) + "px"; box.style.right = "auto";
      } else if (sizing) {
        const w = Math.max(180, Math.min(520, rw + (e.clientX - rx)));
        box.style.width = w + "px"; cfg.width = w; render();
      }
    });
    window.addEventListener("mouseup", () => {
      if (moving) { moving = false; save(LS_POS, { x: box.offsetLeft, y: box.offsetTop }); }
      if (sizing) { sizing = false; saveCfg(); }
    });

    /* ── node names + prompt summary, from the running prompt ─────────── */

    async function loadPrompt() {
      try {
        const r = await api.fetchApi("/queue");
        const q = await r.json();
        const runningItem = (q.queue_running || [])[0];
        const dict = runningItem && runningItem[2];
        if (!dict) return;
        const map = {};
        for (const [id, n] of Object.entries(dict)) {
          map[id] = (n?._meta?.title) || n?.class_type || `node ${id}`;
        }
        nodeNames = map;
        meta = summarise(dict);
      } catch (e) { /* fall back to the graph, then the raw id */ }
    }

    const nodeLabel = (id) => {
      if (id == null) return null;
      const key = String(id);
      if (nodeNames[key]) return nodeNames[key];
      try {
        const n = app.graph?.getNodeById?.(Number(id));
        if (n) return n.title || n.type || `node ${key}`;
      } catch (e) {}
      return `node ${key}`;
    };

    /* ── partial-load watcher ─────────────────────────────────────────── */

    let logSince = null, logCarry = "", logSeen = new Set(), logDead = false;
    const ANSI = /\[[0-9;]*m/g;
    const PATTERNS = [
      [/loaded partially/i, "Partial model load",
       "The model does not fit in VRAM and is being offloaded — "
       + offloadConsequence() + ". Use a smaller model."],
      [/out of memory/i, "Out of memory", "The ComfyUI log reported an out-of-memory "
       + "condition."],
    ];

    async function pollLog() {
      if (logDead || !cfg.warnPartial) return;
      try {
        const r = await api.fetchApi("/internal/logs/raw");
        if (!r.ok) { logDead = true; return; }
        const d = await r.json();
        const entries = d.entries || [];
        let text = "";
        for (const e of entries) {
          if (logSince && e.t <= logSince) continue;
          text += e.m || "";
        }
        if (entries.length) logSince = entries[entries.length - 1].t;

        // entries are write FRAGMENTS, not lines -- join before matching
        logCarry += text.replace(ANSI, "");
        const lines = logCarry.split("\n");
        logCarry = lines.pop() || "";

        for (const line of lines) {
          // Record how the model actually loaded. Only the log knows this, and
          // it is the single most useful fact when a run is slow or dies.
          const lm = line.match(
            /loaded (completely|partially);\s*(?:([\d.]+) MB usable, )?([\d.]+) MB loaded(?:, ([\d.]+) MB offloaded)?/);
          if (lm && parseFloat(lm[3]) > 1000) {
            loadInfo = lm[1] === "partially"
              ? `partially - ${(+lm[3] / 1024).toFixed(1)} GB resident, ${(+lm[4] / 1024).toFixed(1)} GB offloaded`
              : `completely - ${(+lm[3] / 1024).toFixed(1)} GB resident`;
          }
          for (const [re, title, msg] of PATTERNS) {
            if (!re.test(line)) continue;
            const key = line.trim().slice(0, 120);
            if (logSeen.has(key)) continue;      // the buffer repeats every poll
            logSeen.add(key);
            if (logSeen.size > 200) logSeen = new Set();
            pushAlert(title, msg + "  [" + key + "]");
          }
        }
      } catch (e) {
        logDead = true;
        console.warn("[AMDMonitor] /internal/logs/raw unavailable -- partial-load "
                     + "warning disabled");
      }
    }

    /* ── run tracking ─────────────────────────────────────────────────── */

    const onStart = (promptId) => {
      if (running) return;
      running = true; runStart = Date.now(); warned = false;
      dropPreview();
      peak = {}; peakRam = 0; spark = []; progress = null; curNode = null;
      meta = null; outputs = []; runErr = ""; logFile = "";
      nodeTimes = []; nodeStart = null; lastNode = null;
      stepTimes = []; lastStep = null; loadInfo = "";

      // A new run supersedes the previous banner. Safe because `warned` re-arms
      // above: a condition that still applies re-announces itself within seconds.
      if (alerts.some((a) => !a.ack)) {
        alerts.forEach((a) => (a.ack = true));
        save(LS_ALERTS, alerts);
        renderLastAlert();
      }
      document.querySelectorAll("#amdm-sticky .amdm-crit").forEach((c) => c.remove());
      loadPrompt();
      if (cfg.saveToDisk) {
        api.fetchApi("/amdmonitor/run/start", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt_id: promptId || "run" }),
        }).then((r) => r.json()).then((j) => { logFile = j.log || ""; })
          .catch(() => {});
      }
    };

    const onEnd = (ok, msg) => {
      if (!running) return;
      running = false;
      dropPreview();                     // the finished image is in the output node
      closeNode();                       // attribute the final node's time
      lastRun = Date.now() - runStart;
      progress = null; curNode = null;
      if (!ok) runErr = msg || "see the ComfyUI log";
      const pk = Object.values(peak).length ? Math.max(...Object.values(peak)) : 0;

      const times = nodeTimes.slice().sort((a, b) => b.ms - a.ms);
      const sps = stepTimes.length
        ? stepTimes.slice().sort((a, b) => a - b)[Math.floor(stepTimes.length / 2)]
        : null;                          // median, so one stall doesn't skew it

      const rec = {
        at: Date.now(), dur: lastRun, peak: pk, peakRam,
        result: ok ? "ok" : "failed", error: runErr,
        model: (meta?.models || []).join(", "), loras: (meta?.loras || []).join(", "),
        size: meta?.size || "", steps: meta?.steps ?? "", sampler: meta?.sampler || "",
        cfg: meta?.cfg ?? "", seed: meta?.seed ?? "", prompt: meta?.prompt || "",
        outputs: outputs.join(", "), log_file: logFile,
        nodes: times.slice(0, 12), load: loadInfo,
        sps: sps != null ? +sps.toFixed(2) : "",
      };
      history.unshift(rec);
      history = history.slice(0, HIST_N);
      save(LS_HIST, history);

      if (cfg.saveToDisk) {
        api.fetchApi("/amdmonitor/run/end", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            when: new Date(rec.at).toISOString(),
            duration_s: Math.round(rec.dur / 1000), result: rec.result,
            model: rec.model, loras: rec.loras, size: rec.size, steps: rec.steps,
            sampler: rec.sampler, seed: rec.seed,
            peak_vram_gb: pk ? +(pk / GB).toFixed(2) : "",
            peak_ram_gb: peakRam ? +(peakRam / GB).toFixed(2) : "",
            error: rec.error, outputs: rec.outputs, log_file: rec.log_file,
            prompt: rec.prompt, negative: meta?.negative || "",
            cfg: rec.cfg, load_state: rec.load, sec_per_step: rec.sps,
            slowest_node: times[0] ? `${times[0].label} ${dur(times[0].ms)}` : "",
            node_times: times.map((t) => `${t.label}=${(t.ms / 1000).toFixed(1)}s`).join("; "),
          }),
        }).catch(() => {});
      }

      if (ok) {
        // A successful run supersedes earlier warnings: whatever they were about
        // has evidently been dealt with, so stop nagging. They stay in the
        // Alerts tab as a record -- only the banner stands down.
        if (alerts.some((a) => !a.ack)) {
          alerts.forEach((a) => (a.ack = true));
          save(LS_ALERTS, alerts);
          renderLastAlert();
          document.querySelectorAll("#amdm-sticky .amdm-crit").forEach((c) => c.remove());
        }
      }

      const pkTxt = pk ? `peak VRAM ${fmtGB(pk)} GB` : "";
      if (ok && cfg.notifyDone) {
        notify("Render finished", `${dur(lastRun)}${pkTxt ? " -- " + pkTxt : ""}`, true);
        beep(true);
      } else if (!ok && cfg.notifyError) {
        pushAlert("Render failed", runErr);
      }
      render();
    };

    api.addEventListener("execution_start", (e) => onStart(e?.detail?.prompt_id));
    api.addEventListener("execution_success", () => onEnd(true));
    api.addEventListener("execution_error", (e) => {
      const d = e?.detail || {};
      onEnd(false, [d.node_type, d.exception_message].filter(Boolean).join(": "));
    });
    api.addEventListener("execution_interrupted", () => {
      running = false; progress = null; curNode = null; render();
    });
    /*
     * Per-node timing. ComfyUI fires `executing` on every transition, and again
     * with node=null when the graph finishes, so the gap between events is
     * exactly how long the previous node took. Measured, never inferred from
     * log text -- timings are the one thing that has to be trustworthy.
     */
    const closeNode = () => {
      if (lastNode == null || nodeStart == null) return;
      const ms = Date.now() - nodeStart;
      const label = nodeLabel(lastNode);
      const prev = nodeTimes.find((t) => t.label === label);
      if (prev) { prev.ms += ms; prev.n += 1; }     // some nodes run more than once
      else nodeTimes.push({ label, ms, n: 1 });
      lastNode = null; nodeStart = null;
    };

    api.addEventListener("executing", (e) => {
      const n = e?.detail?.node ?? e?.detail;
      if (n != null) { onStart(); if (!nodeNames[String(n)]) loadPrompt(); }
      closeNode();
      if (n != null) { lastNode = n; nodeStart = Date.now(); }
      curNode = n == null ? null : nodeLabel(n);
    });
    api.addEventListener("executed", (e) => {
      const o = e?.detail?.output || {};
      for (const k of ["images", "videos", "gifs", "audio"]) {
        for (const it of o[k] || []) if (it?.filename) outputs.push(it.filename);
      }
      outputs = [...new Set(outputs)].slice(0, 12);
    });
    /*
     * Live preview. ComfyUI broadcasts each preview frame as a binary websocket
     * message; this is the same stream the node preview uses, shown in the panel
     * instead so it stays visible wherever the canvas happens to be scrolled.
     *
     * Nothing arrives unless the user has enabled a preview method in ComfyUI's
     * own settings, hence previewSeen -- an empty box looks broken, a hint does
     * not.
     */
    const dropPreview = () => {
      // Every createObjectURL pins its Blob in memory until revoked. Replacing
      // the src alone would leave every earlier frame resident for the life of
      // the tab -- invisible, and unbounded over a long session.
      if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    };

    api.addEventListener("b_preview", (e) => {
      if (!cfg.showPreview) return;
      const blob = e?.detail;
      if (!(blob instanceof Blob)) return;
      previewSeen = true;
      const next = URL.createObjectURL(blob);
      dropPreview();                       // release the frame we are replacing
      previewUrl = next;
      const img = box.querySelector(".amdm-prev img");
      if (img) img.src = next;             // otherwise render() picks it up
    });

    api.addEventListener("progress", (e) => {
      const d = e?.detail || {};
      if (typeof d.value === "number" && typeof d.max === "number" && d.max > 0) {
        // seconds per step, measured between progress events rather than parsed
        // out of tqdm's output
        const now = Date.now();
        if (lastStep && d.value > lastStep.value)
          stepTimes.push((now - lastStep.t) / 1000 / (d.value - lastStep.value));
        lastStep = d.value >= d.max ? null : { t: now, value: d.value };
        progress = { value: d.value, max: d.max };
      }
    });
    api.addEventListener("status", (e) => {
      queue = e?.detail?.exec_info?.queue_remaining ?? 0;
      if (queue === 0 && running) onEnd(true);
    });
    api.addEventListener("reconnecting", () => setConn("reconnecting"));
    api.addEventListener("reconnected", () => { fails = 0; setConn("ok"); });

    function setConn(state) {
      if (conn === state) return;
      conn = state;
      box.classList.toggle("amdm-stale", state !== "ok");
      if (state === "ok") { connEl.style.display = "none"; return; }
      connEl.style.display = "";
      connEl.className = "amdm-conn " + (state === "down" ? "bad" : "warn");
      connEl.textContent = state === "down"
        ? "ComfyUI backend not responding" : "Reconnecting…";
    }

    /* ── render ───────────────────────────────────────────────────────── */

    function render() {
      if (!sys) return;
      const innerW = Math.max(box.clientWidth - 20, 40);
      let html = "";

      if (cfg.showGpus) {
        const devices = (sys.devices || []).filter((d) =>
          (d.vram_total || 0) > 0 && !(cfg.hideIgpu && isIntegrated(d.name)));

        for (const d of devices) {
          const total = d.vram_total, used = total - (d.vram_free || 0);
          const key = d.index ?? d.name;
          peak[key] = Math.max(peak[key] || 0, used);
          const name = String(d.name)
            .replace(/^cuda:\d+\s*/, "").replace(/\s*:\s*native$/, "").trim();

          let extraTxt = "";
          if (cfg.showPeak) {
            const pk = (peak[key] / total) * 100;
            const risky = pk >= cfg.warnAt;
            extraTxt = `peak <span class="${risky ? "amdm-warn" : ""}">${
              fmtGB(peak[key])} GB</span>${risky ? " &#9888;" : ""}`;
            if (risky && cfg.warnVram && !warned) {
              warned = true;
              // Critical only where running out actually kills the run. On CUDA
              // this is a performance note, and a red sticky card would be
              // crying wolf -- which trains people to disable the warnings that
              // do matter.
              const msg = `${name} reached ${pk.toFixed(0)}% — ${offloadConsequence()}.`;
              if (aborts()) pushAlert("VRAM critical", msg);
              else toast(`VRAM high — ${msg}`, false);
            }
          }
          html += bar(name, used, total, extraTxt);
        }

        const first = devices[0];
        if (cfg.showSpark && first) {
          spark.push(((first.vram_total - first.vram_free) / first.vram_total) * 100);
          if (spark.length > SPARK_N) spark.shift();
          html += sparkline(spark, innerW);
        }
      }

      if (sys.system?.ram_total) {
        const ramUsed = sys.system.ram_total - sys.system.ram_free;
        peakRam = Math.max(peakRam, ramUsed);
        if (cfg.showRam) html += bar("System RAM", ramUsed, sys.system.ram_total, "");
      }

      if (extra?.available) {
        if (cfg.showSwap && extra.swap_total) {
          html += bar("Swap", extra.swap_used, extra.swap_total, "",
                      extra.swap_used / extra.swap_total > 0.5 ? "#faad14" : "#52c41a");
        }
        if (cfg.showCpu && extra.cpu_percent != null) {
          const pc = extra.cpu_percent;
          html += `<div class="amdm-row">
              <div class="amdm-label"><span>CPU</span><span class="amdm-num">${
                pc.toFixed(0)}%${extra.cpu_count ? ` &middot; ${extra.cpu_count}t` : ""
              }</span></div>
              <div class="amdm-track"><div class="amdm-fill" style="width:${
                Math.min(pc, 100)}%;background:${colour(pc)}"></div></div></div>`;
        }
        if (cfg.showDisk && extra.disk_total) {
          html += bar("Output disk", extra.disk_total - extra.disk_free,
                      extra.disk_total, `${fmtGB(extra.disk_free)} GB free`);
        }
        if (cfg.showIo && (extra.disk_read_bps != null || extra.net_recv_bps != null)) {
          html += `<div class="amdm-sec">
            <div class="amdm-kv"><span>disk r/w</span><span>${
              rate(extra.disk_read_bps)} / ${rate(extra.disk_write_bps)}</span></div>
            <div class="amdm-kv"><span>net down/up</span><span>${
              rate(extra.net_recv_bps)} / ${rate(extra.net_sent_bps)}</span></div></div>`;
        }
      }

      const runBits = [];
      if (cfg.showProgress && running && progress) {
        const pc = (progress.value / progress.max) * 100;
        const el = Date.now() - runStart;
        const eta = pc > 2 ? dur(el * (100 - pc) / pc) : "--";
        runBits.push(`<div class="amdm-row" style="margin-bottom:5px">
            <div class="amdm-label"><span>step ${progress.value}/${progress.max}</span>
              <span class="amdm-num">ETA ${eta}</span></div>
            <div class="amdm-track"><div class="amdm-fill"
              style="width:${pc}%;background:#52c41a"></div></div></div>`);
      }
      if (cfg.showNode && curNode)
        runBits.push(`<div class="amdm-node">&#9654; ${esc(curNode)}</div>`);
      if (cfg.showPreview && running) {
        runBits.push(previewUrl
          ? `<div class="amdm-prev"><img src="${previewUrl}" alt="preview"></div>`
          : `<div class="amdm-prevhint">${previewSeen
              ? "waiting for the first frame…"
              : "No preview received — enable a preview method in ComfyUI's settings."
            }</div>`);
      }
      if (cfg.showQueue && queue > 0)
        runBits.push(`<div class="amdm-kv"><span>queued</span><b>${queue}</b></div>`);
      if (cfg.showTimer) {
        runBits.push(`<div class="amdm-kv"><span class="${running ? "amdm-run" : ""}">${
          running && runStart ? "running " + dur(Date.now() - runStart) : "idle"
        }</span><span>${lastRun ? "last " + dur(lastRun) : ""}</span></div>`);
      }
      if (runBits.length) html += `<div class="amdm-sec">${runBits.join("")}</div>`;

      bodyEl.innerHTML = html || "nothing selected";
    }

    /* ── poll ─────────────────────────────────────────────────────────── */

    let routeMissing = false;

    async function tick() {
      let ok = true;
      try {
        sys = await (await api.fetchApi("/system_stats")).json();
        if (BACKEND === "unknown") BACKEND = detectBackend(sys);
      } catch (e) { ok = false; }

      if (!ok) {
        // A restart is routine. Keep the last values on screen, dimmed, and only
        // escalate to red after several consecutive failures.
        fails++;
        setConn(fails >= 5 ? "down" : "reconnecting");
        return;
      }
      fails = 0;
      if (conn !== "ok") setConn("ok");

      if (!routeMissing) {
        try {
          const r2 = await api.fetchApi("/amdmonitor/stats");
          if (r2.ok) extra = await r2.json();
          else { routeMissing = true; extra = null; }
        } catch (e) { routeMissing = true; extra = null; }
        if (routeMissing) {
          console.warn("[AMDMonitor] /amdmonitor/stats unavailable -- swap/CPU/disk "
                       + "rows hidden and nothing will be written to disk.");
        }
      }
      render();
    }

    api.fetchApi("/amdmonitor/runs").then((r) => r.json())
      .then((j) => { dataDir = j.dir || ""; }).catch(() => {});

    /*
     * Update check. ComfyUI Manager only flags updates for packs installed from
     * the registry, so anyone tracking the git repo never gets told -- which is
     * how you end up running something months old without noticing.
     */
    // Always fetch the installed version; only reach the network for the latest
    // one when the toggle allows it.
    function loadVersion(force) {
      const age = Math.max(0.25, +cfg.updateCheckHours || 6) * 3600;
      const q = !cfg.checkUpdates ? "?check=0"
              : force ? "?force=1" : `?max_age=${Math.round(age)}`;
      return api.fetchApi("/amdmonitor/version" + q).then((r) => r.json())
        .then((v) => {
          Object.assign(VER, v);
          if (!v.update) return v;
          const el = box.querySelector(".amdm-title");
          el.innerHTML = `GPU / System <span class="amdm-upd"
            title="Installed ${esc(v.installed)} — click to open the repository">v${
            esc(v.latest)} available</span>`;
          el.querySelector(".amdm-upd").onclick = (e) => {
            e.stopPropagation(); window.open(v.url, "_blank");
          };
          if (!force) toast(`AMD Monitor ${v.latest} is available (you have ${v.installed})`);
          return v;
        }).catch(() => VER);
    }

    aiLoadConfig();
    loadVersion(false);
    // The check otherwise only ever runs at page load, so a long-lived ComfyUI
    // session would never see a new release however short the cache window is.
    setInterval(() => { if (cfg.checkUpdates) loadVersion(false); },
                Math.max(0.25, +cfg.updateCheckHours || 6) * 3600 * 1000);
    tick();
    setInterval(tick, cfg.pollMs);
    setInterval(() => { if (running || !logDead) pollLog(); }, cfg.logPollMs);
    console.log("[AMDMonitor] ready -- stats " + cfg.pollMs + "ms, log "
                + cfg.logPollMs + "ms");
  },
});
