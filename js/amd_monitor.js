import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

/*
 * AMD VRAM + system monitor, with run progress and notifications.
 *
 * VRAM comes from ComfyUI's own /system_stats, which reports correctly on ROCm
 * because it goes through PyTorch's HIP backend instead of NVML. Crystools
 * cannot do this because it calls pynvml directly, which is NVIDIA-only.
 *
 * Swap / CPU / disk / network come from this extension's own /amdmonitor/stats
 * (psutil). If that route is missing -- old install, psutil absent -- those rows
 * simply do not render. Nothing breaks.
 *
 * Every row and every alert has its own toggle, grouped in the gear panel.
 */

const GB = 1024 ** 3;
const LS_POS = "amdmonitor.pos";
const LS_CFG = "amdmonitor.cfg";
const SPARK_N = 60;          // samples kept for the graph
const HIST_N = 5;            // runs kept in history

const DEFAULTS = {
  pollMs: 2000,
  width: 216,
  // display
  showGpus: true,
  showTorchSplit: true,
  showSpark: true,
  showRam: true,
  showSwap: true,
  showCpu: true,
  showDisk: true,
  showIo: false,
  showPeak: true,
  showProgress: true,
  showNode: true,
  showQueue: true,
  showTimer: true,
  showHistory: false,
  // alerts
  notifyDone: true,
  notifyError: true,
  soundDone: true,
  warnVram: true,
  warnAt: 92,
};

let cfg = { ...DEFAULTS };
try { Object.assign(cfg, JSON.parse(localStorage.getItem(LS_CFG) || "{}")); }
catch (e) { /* corrupt value -- keep defaults */ }
const saveCfg = () => {
  try { localStorage.setItem(LS_CFG, JSON.stringify(cfg)); } catch (e) {}
};

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
const esc = (s) => String(s).replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function colour(pct) {
  if (pct >= cfg.warnAt) return "#ff4d4f";
  if (pct >= 80) return "#faad14";
  return "#52c41a";
}

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
  if (samples.length < 2) return "";
  const h = 26, n = samples.length;
  const pts = samples.map((v, i) =>
    `${(i / (n - 1) * w).toFixed(1)},${(h - (v / 100) * h).toFixed(1)}`).join(" ");
  const last = samples[samples.length - 1];
  return `<svg class="amdm-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"
            preserveAspectRatio="none">
            <polyline points="${pts}" fill="none" stroke="${colour(last)}"
              stroke-width="1.5" vector-effect="non-scaling-stroke"/>
          </svg>`;
}

/* ── notifications ──────────────────────────────────────────────────────── */

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
  } catch (e) { /* autoplay blocked until the page is interacted with */ }
}

let toastEl = null;
function toast(text, ok = true) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.id = "amdm-toast";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.style.borderLeftColor = ok ? "#52c41a" : "#ff4d4f";
  toastEl.classList.add("amdm-show");
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove("amdm-show"), 6000);
}

function notify(title, body, ok = true) {
  toast(title + (body ? " -- " + body : ""), ok);
  if ("Notification" in window && Notification.permission === "granted") {
    try { new Notification(title, { body, tag: "amdmonitor" }); } catch (e) {}
  }
}

/* ── settings panel layout ──────────────────────────────────────────────── */

const SECTIONS = [
  ["Display", [
    ["showGpus",       "GPU bars"],
    ["showTorchSplit", "ComfyUI vs other VRAM"],
    ["showSpark",      "VRAM graph"],
    ["showPeak",       "Peak VRAM"],
    ["showRam",        "System RAM"],
  ]],
  ["System (needs psutil route)", [
    ["showSwap",  "Swap"],
    ["showCpu",   "CPU"],
    ["showDisk",  "Output disk free"],
    ["showIo",    "Disk / network rates"],
  ]],
  ["Run", [
    ["showProgress", "Progress + ETA"],
    ["showNode",     "Current node"],
    ["showQueue",    "Queue depth"],
    ["showTimer",    "Run timer"],
    ["showHistory",  "Recent runs"],
  ]],
  ["Alerts", [
    ["notifyDone",  "Notify on finish"],
    ["notifyError", "Notify on error"],
    ["soundDone",   "Sound"],
    ["warnVram",    "Warn at high VRAM"],
  ]],
];

app.registerExtension({
  name: "amd.monitor",

  async setup() {
    const css = document.createElement("style");
    css.textContent = `
      #amd-monitor { position:fixed; top:8px; right:8px; z-index:1200;
        width:${cfg.width}px; min-width:180px; max-width:520px;
        padding:8px 10px 6px; font:11px/1.35 -apple-system,"Segoe UI",sans-serif;
        color:#e6e6e6; background:rgba(24,24,27,.92); border:1px solid #3f3f46;
        border-radius:8px; backdrop-filter:blur(6px); user-select:none; }
      #amd-monitor.amdm-min .amdm-body, #amd-monitor.amdm-min .amdm-cfg { display:none; }
      .amdm-head { display:flex; align-items:center; gap:6px; font-weight:600;
                   margin-bottom:6px; cursor:move; }
      .amdm-head .amdm-title { flex:1; white-space:nowrap; overflow:hidden;
                               text-overflow:ellipsis; }
      .amdm-head button { all:unset; cursor:pointer; opacity:.55; padding:0 2px;
                          font-size:12px; }
      .amdm-head button:hover { opacity:1; }
      .amdm-row { margin-bottom:7px; }
      .amdm-label { display:flex; justify-content:space-between; gap:8px;
                    margin-bottom:3px; }
      .amdm-label > span:first-child { white-space:nowrap; overflow:hidden;
                                       text-overflow:ellipsis; }
      .amdm-num { opacity:.7; font-variant-numeric:tabular-nums; white-space:nowrap; }
      .amdm-track { height:5px; background:#3f3f46; border-radius:3px; overflow:hidden; }
      .amdm-fill { height:100%; border-radius:3px; transition:width .3s, background .3s; }
      .amdm-sub { margin-top:2px; font-size:10px; opacity:.55;
                  font-variant-numeric:tabular-nums; }
      .amdm-spark { display:block; margin:1px 0 4px; }
      .amdm-warn { color:#ff4d4f; font-weight:600; opacity:1; }
      .amdm-sec { margin-top:5px; padding-top:5px; border-top:1px solid #3f3f46; }
      .amdm-kv { display:flex; justify-content:space-between; gap:8px; font-size:10.5px;
                 opacity:.8; font-variant-numeric:tabular-nums; padding:1px 0; }
      .amdm-kv b { font-weight:600; opacity:.95; }
      .amdm-node { font-size:10px; opacity:.7; white-space:nowrap; overflow:hidden;
                   text-overflow:ellipsis; }
      .amdm-run { color:#52c41a; }
      .amdm-cfg { display:none; margin-top:6px; padding-top:6px;
                  border-top:1px solid #3f3f46; max-height:60vh; overflow-y:auto; }
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
      #amdm-toast { position:fixed; bottom:16px; right:16px; z-index:1300;
        max-width:300px; padding:9px 13px; font:12px/1.4 "Segoe UI",sans-serif;
        color:#e6e6e6; background:rgba(24,24,27,.96); border-left:3px solid #52c41a;
        border-radius:6px; opacity:0; transform:translateY(8px);
        transition:opacity .25s, transform .25s; pointer-events:none; }
      #amdm-toast.amdm-show { opacity:1; transform:translateY(0); }
    `;
    document.head.appendChild(css);

    const box = document.createElement("div");
    box.id = "amd-monitor";
    box.innerHTML = `
      <div class="amdm-grip" title="drag to resize"></div>
      <div class="amdm-head">
        <span class="amdm-title">GPU / System</span>
        <button class="amdm-gear" title="settings">&#9881;</button>
        <button class="amdm-fold" title="collapse">&#9662;</button>
      </div>
      <div class="amdm-body">connecting&hellip;</div>
      <div class="amdm-cfg">
        ${SECTIONS.map(([name, items]) => `<h4>${esc(name)}</h4>` + items.map(
            ([k, label]) => `<label><input type="checkbox" data-k="${k}"${
              cfg[k] ? " checked" : ""}> ${esc(label)}</label>`).join("")).join("")}
        <div class="amdm-btns">
          <button class="amdm-reset">reset peak</button>
          <button class="amdm-test">test alert</button>
          <button class="amdm-defaults">defaults</button>
        </div>
      </div>`;
    document.body.appendChild(box);

    const bodyEl = box.querySelector(".amdm-body");
    const cfgBox = box.querySelector(".amdm-cfg");

    try {
      const p = JSON.parse(localStorage.getItem(LS_POS) || "null");
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        box.style.left = p.x + "px"; box.style.top = p.y + "px"; box.style.right = "auto";
      }
    } catch (e) {}

    box.querySelector(".amdm-fold").onclick = () => box.classList.toggle("amdm-min");
    box.querySelector(".amdm-gear").onclick = () => {
      cfgBox.classList.toggle("amdm-open");
      // Permission can only be requested from a user gesture.
      if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
      }
    };
    cfgBox.querySelectorAll("input[type=checkbox]").forEach((el) => {
      el.onchange = () => { cfg[el.dataset.k] = el.checked; saveCfg(); render(); };
    });

    /* ── state ────────────────────────────────────────────────────────── */

    let peak = {}, spark = [], history = [];
    let sys = null, extra = null;
    let running = false, runStart = null, lastRun = null, warned = false;
    let progress = null, curNode = null, queue = 0;

    box.querySelector(".amdm-reset").onclick = () => {
      peak = {}; spark = []; toast("Peak and graph reset");
    };
    box.querySelector(".amdm-test").onclick = () => {
      notify("AMDMonitor", "This is what a finished run looks like", true); beep(true);
    };
    box.querySelector(".amdm-defaults").onclick = () => {
      cfg = { ...DEFAULTS }; saveCfg();
      cfgBox.querySelectorAll("input[type=checkbox]").forEach(
        (el) => (el.checked = cfg[el.dataset.k]));
      box.style.width = cfg.width + "px";
      render();
      toast("Settings reset to defaults");
    };

    /* ── drag to move, grip to resize ─────────────────────────────────── */

    let mx = 0, my = 0, moving = false;
    box.querySelector(".amdm-head").addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      moving = true; mx = e.clientX - box.offsetLeft; my = e.clientY - box.offsetTop;
      e.preventDefault();
    });

    let rx = 0, rw = 0, sizing = false;
    box.querySelector(".amdm-grip").addEventListener("mousedown", (e) => {
      sizing = true; rx = e.clientX; rw = box.offsetWidth;
      e.preventDefault(); e.stopPropagation();
    });

    window.addEventListener("mousemove", (e) => {
      if (moving) {
        box.style.left = (e.clientX - mx) + "px";
        box.style.top = (e.clientY - my) + "px";
        box.style.right = "auto";
      } else if (sizing) {
        // grip is on the right edge, so dragging right widens
        const w = Math.max(180, Math.min(520, rw + (e.clientX - rx)));
        box.style.width = w + "px";
        cfg.width = w;
        render();
      }
    });
    window.addEventListener("mouseup", () => {
      if (moving) {
        moving = false;
        try {
          localStorage.setItem(LS_POS,
            JSON.stringify({ x: box.offsetLeft, y: box.offsetTop }));
        } catch (e) {}
      }
      if (sizing) { sizing = false; saveCfg(); }
    });

    /* ── run tracking ─────────────────────────────────────────────────── */

    const nodeLabel = (id) => {
      try {
        const n = app.graph?.getNodeById?.(Number(id));
        if (n) return n.title || n.type || `node ${id}`;
      } catch (e) {}
      return id != null ? `node ${id}` : null;
    };

    const onStart = () => {
      if (running) return;
      running = true; runStart = Date.now(); warned = false;
      peak = {}; spark = []; progress = null; curNode = null;
    };

    const onEnd = (ok, msg) => {
      if (!running) return;
      running = false;
      lastRun = Date.now() - runStart;
      progress = null; curNode = null;
      const pk = Object.values(peak).length ? Math.max(...Object.values(peak)) : 0;
      history.unshift({ dur: lastRun, peak: pk, ok, at: Date.now() });
      history = history.slice(0, HIST_N);
      const pkTxt = pk ? `peak VRAM ${fmtGB(pk)} GB` : "";
      if (ok && cfg.notifyDone) {
        notify("Render finished", `${dur(lastRun)}${pkTxt ? " -- " + pkTxt : ""}`, true);
        beep(true);
      } else if (!ok && cfg.notifyError) {
        notify("Render FAILED", msg || "see the ComfyUI log", false);
        beep(false);
      }
      render();
    };

    api.addEventListener("execution_start", onStart);
    api.addEventListener("execution_success", () => onEnd(true));
    api.addEventListener("execution_error", (e) =>
      onEnd(false, e?.detail?.exception_message));
    api.addEventListener("execution_interrupted", () => {
      running = false; progress = null; curNode = null; render();
    });
    api.addEventListener("executing", (e) => {
      const n = e?.detail?.node ?? e?.detail;
      curNode = (n === null || n === undefined) ? null : nodeLabel(n);
      if (n != null) onStart();
    });
    api.addEventListener("progress", (e) => {
      const d = e?.detail || {};
      if (typeof d.value === "number" && typeof d.max === "number" && d.max > 0) {
        progress = { value: d.value, max: d.max };
      }
    });
    api.addEventListener("status", (e) => {
      queue = e?.detail?.exec_info?.queue_remaining ?? 0;
      if (queue === 0 && running) onEnd(true);   // fallback for older builds
    });

    /* ── render ───────────────────────────────────────────────────────── */

    function render() {
      if (!sys) return;
      const innerW = box.clientWidth - 20;   // minus padding, for the sparkline
      let html = "";

      if (cfg.showGpus) {
        for (const d of sys.devices || []) {
          const total = d.vram_total || 0;
          if (total <= 0) continue;
          const used = total - (d.vram_free || 0);
          const key = d.index ?? d.name;
          peak[key] = Math.max(peak[key] || 0, used);

          const name = String(d.name)
            .replace(/^cuda:\d+\s*/, "").replace(/\s*:\s*native$/, "").trim();

          const bits = [];
          if (cfg.showPeak) {
            const pk = (peak[key] / total) * 100;
            const risky = pk >= cfg.warnAt;
            bits.push(`peak <span class="${risky ? "amdm-warn" : ""}">` +
                      `${fmtGB(peak[key])} GB</span>${risky ? " &#9888;" : ""}`);
            if (risky && cfg.warnVram && !warned) {
              warned = true;
              notify("VRAM critical",
                `${name} at ${pk.toFixed(0)}% -- offload risk, ROCm may abort`, false);
            }
          }
          if (cfg.showTorchSplit && d.torch_vram_total != null) {
            // What ComfyUI's allocator holds, versus everything else on the card.
            const torchUsed = Math.max((d.torch_vram_total || 0) -
                                       (d.torch_vram_free || 0), 0);
            const other = Math.max(used - torchUsed, 0);
            bits.push(`ComfyUI ${fmtGB(torchUsed)} &middot; other ${fmtGB(other)}`);
          }
          html += bar(name, used, total, bits.join(" &middot; "));
        }

        // graph follows the first device with VRAM
        const first = (sys.devices || []).find((d) => (d.vram_total || 0) > 0);
        if (cfg.showSpark && first) {
          const pct = ((first.vram_total - first.vram_free) / first.vram_total) * 100;
          spark.push(pct);
          if (spark.length > SPARK_N) spark.shift();
          html += sparkline(spark, Math.max(innerW, 40));
        }
      }

      if (cfg.showRam && sys.system?.ram_total) {
        html += bar("System RAM",
          sys.system.ram_total - sys.system.ram_free, sys.system.ram_total, "");
      }

      if (extra?.available) {
        if (cfg.showSwap && extra.swap_total) {
          // Swap in use means memory has spilled to disk -- everything gets slow.
          html += bar("Swap", extra.swap_used, extra.swap_total, "",
                      extra.swap_used / extra.swap_total > 0.5 ? "#faad14" : "#52c41a");
        }
        if (cfg.showCpu && extra.cpu_percent != null) {
          const p = extra.cpu_percent;
          html += `<div class="amdm-row">
              <div class="amdm-label"><span>CPU</span>
                <span class="amdm-num">${p.toFixed(0)}%${
                  extra.cpu_count ? ` &middot; ${extra.cpu_count}t` : ""}</span></div>
              <div class="amdm-track"><div class="amdm-fill"
                style="width:${Math.min(p, 100)}%;background:${colour(p)}"></div></div>
            </div>`;
        }
        if (cfg.showDisk && extra.disk_total) {
          const usedD = extra.disk_total - extra.disk_free;
          html += bar("Output disk", usedD, extra.disk_total,
                      `${fmtGB(extra.disk_free)} GB free`);
        }
        if (cfg.showIo && (extra.disk_read_bps != null || extra.net_recv_bps != null)) {
          html += `<div class="amdm-sec">
            <div class="amdm-kv"><span>disk r/w</span>
              <span>${rate(extra.disk_read_bps)} / ${rate(extra.disk_write_bps)}</span></div>
            <div class="amdm-kv"><span>net down/up</span>
              <span>${rate(extra.net_recv_bps)} / ${rate(extra.net_sent_bps)}</span></div>
          </div>`;
        }
      }

      // ── run section ──────────────────────────────────────────────────
      const runBits = [];

      if (cfg.showProgress && running && progress) {
        const p = (progress.value / progress.max) * 100;
        const el = Date.now() - runStart;
        const eta = p > 2 ? dur(el * (100 - p) / p) : "--";
        runBits.push(`<div class="amdm-row" style="margin-bottom:5px">
            <div class="amdm-label"><span>step ${progress.value}/${progress.max}</span>
              <span class="amdm-num">ETA ${eta}</span></div>
            <div class="amdm-track"><div class="amdm-fill"
              style="width:${p}%;background:#52c41a"></div></div></div>`);
      }
      if (cfg.showNode && curNode) {
        runBits.push(`<div class="amdm-node">&#9654; ${esc(curNode)}</div>`);
      }
      if (cfg.showQueue && queue > 0) {
        runBits.push(`<div class="amdm-kv"><span>queued</span><b>${queue}</b></div>`);
      }
      if (cfg.showTimer) {
        runBits.push(`<div class="amdm-kv">
            <span class="${running ? "amdm-run" : ""}">${
              running && runStart ? "running " + dur(Date.now() - runStart) : "idle"}</span>
            <span>${lastRun ? "last " + dur(lastRun) : ""}</span></div>`);
      }
      if (cfg.showHistory && history.length) {
        runBits.push(history.map((h) =>
          `<div class="amdm-kv"><span>${h.ok ? "" : "&#10007; "}${
            new Date(h.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          }</span><span>${dur(h.dur)}${h.peak ? " &middot; " + fmtGB(h.peak) + " GB" : ""
          }</span></div>`).join(""));
      }
      if (runBits.length) html += `<div class="amdm-sec">${runBits.join("")}</div>`;

      bodyEl.innerHTML = html || "nothing selected";
    }

    /* ── poll ─────────────────────────────────────────────────────────── */

    let routeMissing = false;

    async function tick() {
      try {
        const r = await api.fetchApi("/system_stats");
        sys = await r.json();
      } catch (e) {
        bodyEl.innerHTML = `<span class="amdm-warn">/system_stats unreachable</span>`;
        return;
      }
      if (!routeMissing) {
        try {
          const r2 = await api.fetchApi("/amdmonitor/stats");
          if (r2.ok) extra = await r2.json();
          else { routeMissing = true; extra = null; }
        } catch (e) { routeMissing = true; extra = null; }
        if (routeMissing) {
          console.warn("[AMDMonitor] /amdmonitor/stats unavailable -- " +
                       "swap/CPU/disk rows hidden. Update __init__.py.");
        }
      }
      render();
    }

    tick();
    setInterval(tick, cfg.pollMs);
    console.log("[AMDMonitor] ready -- polling every " + cfg.pollMs + "ms");
  },
});
