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
  warnAt: 92,
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
    if (/RandomNoise/.test(ct) && i.noise_seed != null && out.seed === "")
      out.seed = i.noise_seed;
    if (/EmptyLatent|EmptySD3|EmptyLTXV/i.test(ct) && i.width && i.height)
      out.size = `${i.width}x${i.height}`;
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
      .amdm-node { font-size:10px; opacity:.7; white-space:nowrap; overflow:hidden;
                   text-overflow:ellipsis; }
      .amdm-run { color:#52c41a; }
      .amdm-cfg { display:none; margin-top:6px; padding-top:6px; border-top:1px solid #3f3f46;
                  max-height:60vh; overflow-y:auto; }
      .amdm-cfg.amdm-open { display:block; }
      .amdm-cfg h4 { margin:6px 0 2px; font-size:9.5px; text-transform:uppercase;
                     letter-spacing:.06em; opacity:.45; font-weight:700; }
      .amdm-cfg h4:first-child { margin-top:0; }
      .amdm-cfg label { display:flex; align-items:center; gap:6px; padding:2px 0;
                        cursor:pointer; font-size:10.5px; }
      .amdm-cfg input[type=checkbox] { accent-color:#52c41a; cursor:pointer; margin:0; }
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
      #amdm-modal tr.row { cursor:pointer; }
      #amdm-modal tr.row:hover td { background:#ffffff08; }
      #amdm-modal .amdm-detail td { font-size:11px; opacity:.85; background:#ffffff05; }
      #amdm-modal .amdm-detail div { padding:2px 0; }
      #amdm-modal .amdm-detail .k { display:inline-block; min-width:78px; opacity:.5; }
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
        ["saveToDisk", "Save runs and logs to disk"],
      ]],
      ["Alerts", [
        ["notifyDone", "Notify on finish"], ["notifyError", "Notify on error"],
        ["soundDone", "Sound"], ["warnVram", "Warn at high VRAM"],
        ["warnPartial", "Warn on partial model load"],
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
      <div class="amdm-body">connecting&hellip;</div>
      <div class="amdm-cfg">
        ${SECTIONS.map(([n, items]) => `<h4>${esc(n)}</h4>` + items.map(([k, l]) =>
          `<label><input type="checkbox" data-k="${k}"${cfg[k] ? " checked" : ""}>
             ${esc(l)}</label>`).join("")).join("")}
        <div class="amdm-btns">
          <button class="amdm-reset">Reset Peak</button>
          <button class="amdm-test">Test Alert</button>
          <button class="amdm-defaults">Defaults</button>
        </div>
      </div>`;
    document.body.appendChild(box);

    const bodyEl = box.querySelector(".amdm-body");
    const connEl = box.querySelector(".amdm-conn");
    const alertEl = box.querySelector(".amdm-lastalert");
    const cfgBox = box.querySelector(".amdm-cfg");
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
             ["Sampler", h.sampler], ["Steps", h.steps], ["Seed", h.seed],
             ["Peak RAM", h.peakRam ? fmtGB(h.peakRam) + " GB" : ""],
             ["Outputs", h.outputs], ["Log", h.log_file],
             ["Error", h.error], ["Prompt", h.prompt]]
            .filter(([, v]) => v !== undefined && v !== null && v !== "")
            .map(([k, v]) => `<div><span class="k">${k}</span>${esc(v)}</div>`).join("")}
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
          <div class="amdm-btns">
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

    histBtn.onclick = () => showHistory("runs");
    box.querySelector(".amdm-fold").onclick = () => box.classList.toggle("amdm-min");
    box.querySelector(".amdm-gear").onclick = () => {
      cfgBox.classList.toggle("amdm-open");
      if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
      }
    };
    cfgBox.querySelectorAll("input[type=checkbox]").forEach((el) => {
      el.onchange = () => { cfg[el.dataset.k] = el.checked; saveCfg(); render(); };
    });

    /* ── state ────────────────────────────────────────────────────────── */

    let peak = {}, peakRam = 0, spark = [];
    let sys = null, extra = null;
    let running = false, runStart = null, lastRun = null, warned = false;
    let progress = null, curNode = null, queue = 0;
    let nodeNames = {}, meta = null, outputs = [], runErr = "", logFile = "";
    let conn = "ok", fails = 0;

    box.querySelector(".amdm-reset").onclick = () => {
      peak = {}; peakRam = 0; spark = []; toast("Peak and graph reset");
    };
    box.querySelector(".amdm-test").onclick = () =>
      pushAlert("Test alert", "This is what a critical warning looks like. It stays "
        + "until you dismiss it, and survives a restart.");
    box.querySelector(".amdm-defaults").onclick = () => {
      cfg = { ...DEFAULTS }; saveCfg();
      cfgBox.querySelectorAll("input[type=checkbox]").forEach(
        (el) => (el.checked = cfg[el.dataset.k]));
      box.style.width = cfg.width + "px"; render(); toast("Settings reset to defaults");
    };

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
       "The model does not fit in VRAM and is being offloaded. On ROCm this is "
       + "normally followed by a hard abort with no traceback. Use a smaller model."],
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
      peak = {}; peakRam = 0; spark = []; progress = null; curNode = null;
      meta = null; outputs = []; runErr = ""; logFile = "";
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
      lastRun = Date.now() - runStart;
      progress = null; curNode = null;
      if (!ok) runErr = msg || "see the ComfyUI log";
      const pk = Object.values(peak).length ? Math.max(...Object.values(peak)) : 0;

      const rec = {
        at: Date.now(), dur: lastRun, peak: pk, peakRam,
        result: ok ? "ok" : "failed", error: runErr,
        model: (meta?.models || []).join(", "), loras: (meta?.loras || []).join(", "),
        size: meta?.size || "", steps: meta?.steps ?? "", sampler: meta?.sampler || "",
        seed: meta?.seed ?? "", prompt: meta?.prompt || "",
        outputs: outputs.join(", "), log_file: logFile,
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
          }),
        }).catch(() => {});
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
    api.addEventListener("executing", (e) => {
      const n = e?.detail?.node ?? e?.detail;
      if (n != null) { onStart(); if (!nodeNames[String(n)]) loadPrompt(); }
      curNode = n == null ? null : nodeLabel(n);
    });
    api.addEventListener("executed", (e) => {
      const o = e?.detail?.output || {};
      for (const k of ["images", "videos", "gifs", "audio"]) {
        for (const it of o[k] || []) if (it?.filename) outputs.push(it.filename);
      }
      outputs = [...new Set(outputs)].slice(0, 12);
    });
    api.addEventListener("progress", (e) => {
      const d = e?.detail || {};
      if (typeof d.value === "number" && typeof d.max === "number" && d.max > 0)
        progress = { value: d.value, max: d.max };
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
              pushAlert("VRAM critical",
                `${name} reached ${pk.toFixed(0)}% -- offload risk, ROCm may abort.`);
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

    tick();
    setInterval(tick, cfg.pollMs);
    setInterval(() => { if (running || !logDead) pollLog(); }, cfg.logPollMs);
    console.log("[AMDMonitor] ready -- stats " + cfg.pollMs + "ms, log "
                + cfg.logPollMs + "ms");
  },
});
