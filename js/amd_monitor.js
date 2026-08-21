import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

/*
 * AMD VRAM monitor + run notifications.
 *
 * Reads ComfyUI's own /system_stats, which reports VRAM correctly on ROCm
 * because it goes through PyTorch's HIP backend instead of NVML. Crystools
 * cannot do this because it calls pynvml directly, which is NVIDIA-only.
 *
 * Two things it adds beyond a resource readout:
 *
 *  - PEAK VRAM. On a 16 GB card, a model that does not fit gets partially
 *    offloaded and ROCm then aborts the whole process. Watching the peak tells
 *    you a workflow is unsafe before it takes ComfyUI down with it.
 *  - Run notifications. Krea2 renders take ~13 minutes; you should be able to
 *    walk away and be told when it is done, or when it failed.
 *
 * Everything is toggleable via the gear icon and persisted in localStorage.
 */

const GB = 1024 ** 3;
const LS_POS = "amdmonitor.pos";
const LS_CFG = "amdmonitor.cfg";

const DEFAULTS = {
  pollMs: 2000,
  showGpus: true,
  showRam: true,
  showPeak: true,
  showTimer: true,
  notifyDone: true,
  notifyError: true,
  soundDone: true,
  warnVram: true,
  warnAt: 92,
};

let cfg = { ...DEFAULTS };
try {
  Object.assign(cfg, JSON.parse(localStorage.getItem(LS_CFG) || "{}"));
} catch (e) { /* corrupt value -- fall back to defaults */ }

const saveCfg = () => {
  try { localStorage.setItem(LS_CFG, JSON.stringify(cfg)); } catch (e) {}
};

const fmt = (b) => (b / GB).toFixed(1);
const pad = (n) => String(n).padStart(2, "0");
const dur = (ms) => {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
};

function colour(pct) {
  if (pct >= cfg.warnAt) return "#ff4d4f";
  if (pct >= 80) return "#faad14";
  return "#52c41a";
}

/* ── notifications ──────────────────────────────────────────────────────── */

function beep(ok = true) {
  if (!cfg.soundDone) return;
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const notes = ok ? [660, 880] : [440, 330];
    notes.forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ac.currentTime + i * 0.16);
      g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + i * 0.16 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + i * 0.16 + 0.15);
      o.connect(g).connect(ac.destination);
      o.start(ac.currentTime + i * 0.16);
      o.stop(ac.currentTime + i * 0.16 + 0.16);
    });
  } catch (e) { /* autoplay blocked until the page is interacted with */ }
}

function notify(title, body, ok = true) {
  toast(title + (body ? " -- " + body : ""), ok);
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") {
    try { new Notification(title, { body, tag: "amdmonitor" }); } catch (e) {}
  }
}

let toastEl = null;
function toast(text, ok = true) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.id = "amdm-toast";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.style.borderColor = ok ? "#52c41a" : "#ff4d4f";
  toastEl.classList.add("amdm-show");
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove("amdm-show"), 6000);
}

/* ── panel ──────────────────────────────────────────────────────────────── */

function bar(label, used, total, extra) {
  const pct = total > 0 ? (used / total) * 100 : 0;
  return `
    <div class="amdm-row">
      <div class="amdm-label"><span>${label}</span>
        <span class="amdm-num">${fmt(used)} / ${fmt(total)} GB</span></div>
      <div class="amdm-track">
        <div class="amdm-fill" style="width:${Math.min(pct, 100)}%;
             background:${colour(pct)}"></div></div>
      <div class="amdm-sub">${pct.toFixed(0)}%${extra ? " &middot; " + extra : ""}</div>
    </div>`;
}

const CHECKS = [
  ["showGpus",    "GPU bars"],
  ["showRam",     "System RAM"],
  ["showPeak",    "Peak VRAM"],
  ["showTimer",   "Run timer"],
  ["notifyDone",  "Notify on finish"],
  ["notifyError", "Notify on error"],
  ["soundDone",   "Sound"],
  ["warnVram",    "Warn at high VRAM"],
];

app.registerExtension({
  name: "amd.monitor",

  async setup() {
    const css = document.createElement("style");
    css.textContent = `
      #amd-monitor { position: fixed; top: 8px; right: 8px; z-index: 1200;
        width: 216px; padding: 8px 10px 6px;
        font: 11px/1.35 -apple-system, "Segoe UI", sans-serif; color: #e6e6e6;
        background: rgba(24,24,27,.92); border: 1px solid #3f3f46;
        border-radius: 8px; backdrop-filter: blur(6px); user-select: none; }
      #amd-monitor.amdm-min .amdm-body, #amd-monitor.amdm-min .amdm-cfg { display:none; }
      .amdm-head { display:flex; align-items:center; gap:6px; font-weight:600;
                   margin-bottom:6px; cursor:move; }
      .amdm-head .amdm-title { flex:1; }
      .amdm-head button { all:unset; cursor:pointer; opacity:.55; padding:0 2px;
                          font-size:12px; }
      .amdm-head button:hover { opacity:1; }
      .amdm-row { margin-bottom: 7px; }
      .amdm-label { display:flex; justify-content:space-between; margin-bottom:3px; }
      .amdm-num { opacity:.7; font-variant-numeric: tabular-nums; }
      .amdm-track { height:5px; background:#3f3f46; border-radius:3px; overflow:hidden; }
      .amdm-fill { height:100%; border-radius:3px; transition:width .3s, background .3s; }
      .amdm-sub { margin-top:2px; font-size:10px; opacity:.55;
                  font-variant-numeric: tabular-nums; }
      .amdm-warn { color:#ff4d4f; font-weight:600; opacity:1; }
      .amdm-timer { margin-top:4px; padding-top:5px; border-top:1px solid #3f3f46;
                    font-size:10px; opacity:.75; font-variant-numeric: tabular-nums;
                    display:flex; justify-content:space-between; }
      .amdm-run { color:#52c41a; }
      .amdm-cfg { display:none; margin-top:6px; padding-top:6px;
                  border-top:1px solid #3f3f46; }
      .amdm-cfg.amdm-open { display:block; }
      .amdm-cfg label { display:flex; align-items:center; gap:6px; padding:2px 0;
                        cursor:pointer; font-size:10.5px; }
      .amdm-cfg input[type=checkbox] { accent-color:#52c41a; cursor:pointer; margin:0; }
      .amdm-cfg .amdm-btns { display:flex; gap:6px; margin-top:6px; }
      .amdm-cfg .amdm-btns button { all:unset; cursor:pointer; font-size:10px;
        padding:3px 7px; border:1px solid #52525b; border-radius:4px; opacity:.85; }
      .amdm-cfg .amdm-btns button:hover { opacity:1; border-color:#71717a; }
      #amdm-toast { position:fixed; bottom:16px; right:16px; z-index:1300;
        max-width:300px; padding:9px 13px; font:12px/1.4 "Segoe UI", sans-serif;
        color:#e6e6e6; background:rgba(24,24,27,.96); border-left:3px solid #52c41a;
        border-radius:6px; opacity:0; transform:translateY(8px);
        transition:opacity .25s, transform .25s; pointer-events:none; }
      #amdm-toast.amdm-show { opacity:1; transform:translateY(0); }
    `;
    document.head.appendChild(css);

    const box = document.createElement("div");
    box.id = "amd-monitor";
    box.innerHTML = `
      <div class="amdm-head">
        <span class="amdm-title">GPU / RAM</span>
        <button class="amdm-gear"  title="settings">&#9881;</button>
        <button class="amdm-fold"  title="collapse">&#9662;</button>
      </div>
      <div class="amdm-body">connecting&hellip;</div>
      <div class="amdm-cfg">
        ${CHECKS.map(([k, label]) =>
          `<label><input type="checkbox" data-k="${k}"${cfg[k] ? " checked" : ""}>
             ${label}</label>`).join("")}
        <div class="amdm-btns">
          <button class="amdm-reset">reset peak</button>
          <button class="amdm-test">test alert</button>
        </div>
      </div>`;
    document.body.appendChild(box);

    const body = box.querySelector(".amdm-body");
    const cfgBox = box.querySelector(".amdm-cfg");

    // restore position
    try {
      const p = JSON.parse(localStorage.getItem(LS_POS) || "null");
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        box.style.left = p.x + "px"; box.style.top = p.y + "px";
        box.style.right = "auto";
      }
    } catch (e) {}

    box.querySelector(".amdm-fold").onclick = () => box.classList.toggle("amdm-min");
    box.querySelector(".amdm-gear").onclick = () => {
      cfgBox.classList.toggle("amdm-open");
      // Permission must be requested from a user gesture, so ask here.
      if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
      }
    };

    cfgBox.querySelectorAll("input[type=checkbox]").forEach((el) => {
      el.onchange = () => {
        cfg[el.dataset.k] = el.checked;
        saveCfg();
        render();
      };
    });

    let peak = {};
    box.querySelector(".amdm-reset").onclick = () => {
      peak = {};
      toast("Peak VRAM reset");
    };
    box.querySelector(".amdm-test").onclick = () => {
      notify("AMDMonitor", "This is what a finished run looks like", true);
      beep(true);
    };

    // drag by the header only, so clicks on the checkboxes still work
    let dx = 0, dy = 0, dragging = false;
    box.querySelector(".amdm-head").addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      dragging = true;
      dx = e.clientX - box.offsetLeft;
      dy = e.clientY - box.offsetTop;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      box.style.left = (e.clientX - dx) + "px";
      box.style.top = (e.clientY - dy) + "px";
      box.style.right = "auto";
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      try {
        localStorage.setItem(LS_POS,
          JSON.stringify({ x: box.offsetLeft, y: box.offsetTop }));
      } catch (e) {}
    });

    /* ── run tracking ───────────────────────────────────────────────────── */

    let runStart = null, lastRun = null, running = false, warned = false;

    const onStart = () => {
      if (running) return;
      running = true; runStart = Date.now(); warned = false;
      peak = {};                       // peak is per-run, that's the useful scope
    };
    const onEnd = (ok, msg) => {
      if (!running) return;
      running = false;
      lastRun = Date.now() - runStart;
      const peakTxt = Object.values(peak).length
        ? `peak VRAM ${fmt(Math.max(...Object.values(peak)))} GB` : "";
      if (ok && cfg.notifyDone) {
        notify("Render finished", `${dur(lastRun)}${peakTxt ? " -- " + peakTxt : ""}`, true);
        beep(true);
      } else if (!ok && cfg.notifyError) {
        notify("Render FAILED", msg || "see the ComfyUI log", false);
        beep(false);
      }
    };

    api.addEventListener("execution_start", onStart);
    api.addEventListener("execution_success", () => onEnd(true));
    api.addEventListener("execution_error", (e) =>
      onEnd(false, e?.detail?.exception_message));
    api.addEventListener("execution_interrupted", () => { running = false; });
    // Fallback for builds that don't emit execution_success.
    api.addEventListener("status", (e) => {
      const q = e?.detail?.exec_info?.queue_remaining;
      if (q === 0 && running) onEnd(true);
    });

    /* ── poll ───────────────────────────────────────────────────────────── */

    let last = null;

    function render() {
      if (!last) return;
      let html = "";

      if (cfg.showGpus) {
        for (const d of last.devices || []) {
          const total = d.vram_total || 0;
          if (total <= 0) continue;
          const used = total - (d.vram_free || 0);
          const key = d.index ?? d.name;
          peak[key] = Math.max(peak[key] || 0, used);

          const name = String(d.name)
            .replace(/^cuda:\d+\s*/, "").replace(/\s*:\s*native$/, "").trim();

          let extra = "";
          if (cfg.showPeak) {
            const pk = (peak[key] / total) * 100;
            const risky = pk >= cfg.warnAt;
            extra = `peak <span class="${risky ? "amdm-warn" : ""}">${fmt(peak[key])} GB</span>` +
                    (risky ? " &#9888;" : "");
            if (risky && cfg.warnVram && !warned) {
              warned = true;
              notify("VRAM critical",
                `${name} at ${pk.toFixed(0)}% -- offload risk, ROCm may abort`, false);
            }
          }
          html += bar(name, used, total, extra);
        }
      }

      if (cfg.showRam && last.system?.ram_total) {
        html += bar("System RAM",
          last.system.ram_total - last.system.ram_free, last.system.ram_total, "");
      }

      if (cfg.showTimer) {
        const now = running && runStart ? dur(Date.now() - runStart) : "idle";
        html += `<div class="amdm-timer">
                   <span class="${running ? "amdm-run" : ""}">${running ? "running " + now : "idle"}</span>
                   <span>${lastRun ? "last " + dur(lastRun) : ""}</span></div>`;
      }

      body.innerHTML = html || "nothing selected";
    }

    async function tick() {
      try {
        const r = await api.fetchApi("/system_stats");
        last = await r.json();
        render();
      } catch (e) {
        body.innerHTML = `<span class="amdm-warn">/system_stats unreachable</span>`;
      }
    }

    tick();
    setInterval(tick, cfg.pollMs);
    console.log("[AMDMonitor] ready -- polling /system_stats every " + cfg.pollMs + "ms");
  },
});
