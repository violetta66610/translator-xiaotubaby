"use strict";
/* 课堂翻译 — live lecture transcription + translation (IT / EN / ZH) */

const LANG = {
  it: { name: "意大利语", full: "Italian" },
  en: { name: "英语", full: "English" },
  zh: { name: "中文", full: "Simplified Chinese" },
  auto: { name: "自动识别", full: "" },
};
const ASR_PRICE = { "gpt-transcribe": 0.0045, "gpt-4o-transcribe": 0.006, "gpt-4o-mini-transcribe": 0.003, "whisper-1": 0.006 };
const ASR_PREFS = ["gpt-transcribe", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"];
const LLM_PREFS = ["gpt-5.4-mini", "gpt-5.6-terra", "gpt-5-mini", "gpt-4.1-mini", "gpt-4o-mini"];
const EFFORTS = ["none", "minimal", "low", null];

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtT = (ms) => { const s = Math.floor(ms / 1000); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((x) => String(x).padStart(2, "0")).join(":"); };
const fmtDate = (t) => new Date(t).toLocaleString("zh-CN", { month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });

/* ---------------- settings ---------------- */
let S = {};
try { S = JSON.parse(localStorage.getItem("lt.settings") || "{}"); } catch (e) {}
S.models = S.models || {}; S.effortIdx = S.effortIdx || 0; S.fs = S.fs || 18;
const saveS = () => { try { localStorage.setItem("lt.settings", JSON.stringify(S)); } catch (e) {} };
document.documentElement.style.setProperty("--fs", S.fs + "px");

/* ---------------- IndexedDB ---------------- */
const DBP = new Promise((res, rej) => {
  const r = indexedDB.open("lecture-translator", 1);
  r.onupgradeneeded = () => {
    const d = r.result;
    d.createObjectStore("courses", { keyPath: "id" });
    d.createObjectStore("sessions", { keyPath: "id" }).createIndex("course", "courseId");
  };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const os = async (n, m = "readonly") => (await DBP).transaction(n, m).objectStore(n);
const db = {
  put: async (n, v) => reqP((await os(n, "readwrite")).put(v)),
  get: async (n, k) => reqP((await os(n)).get(k)),
  all: async (n) => reqP((await os(n)).getAll()),
  del: async (n, k) => reqP((await os(n, "readwrite")).delete(k)),
  sessions: async (cid) => reqP((await os("sessions")).index("course").getAll(cid)),
};
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

/* ---------------- OpenAI ---------------- */
function apiErr(status, body) {
  let m = ""; try { m = JSON.parse(body).error.message; } catch (e) { m = body.slice(0, 200); }
  const e = new Error(m || "HTTP " + status); e.status = status; e.body = body || ""; return e;
}
function friendly(e) {
  if (!e) return "未知错误";
  if (e.status === 401) return "API Key 无效，请到设置里重新填写。";
  if (e.status === 429 && /quota|billing/i.test(e.body)) return "OpenAI 账户余额不足，请到 Billing 充值。";
  if (e.status === 429) return "请求太频繁，稍后自动重试。";
  if (!e.status) return "网络连接失败，恢复网络后会自动重试。";
  return e.message;
}
async function oa(path, opts = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch("https://api.openai.com/v1" + path, { ...opts, headers: { Authorization: "Bearer " + S.key, ...(opts.headers || {}) } });
      if (r.ok) return r;
      last = apiErr(r.status, await r.text());
      if ([400, 401, 403, 404].includes(r.status)) throw last;
      if (r.status === 429 && /quota|billing/i.test(last.body)) throw last;
    } catch (e) {
      if (e.status && [400, 401, 403, 404].includes(e.status)) throw e;
      if (e.status === 429 && /quota|billing/i.test(e.body)) throw e;
      last = e;
    }
    if (i < tries - 1) await sleep(900 * 2 ** i);
  }
  throw last;
}
async function detectModels() {
  const r = await oa("/models", {}, 2);
  const ids = (await r.json()).data.map((m) => m.id);
  const pick = (prefs) => prefs.find((p) => ids.includes(p));
  S.models = { asr: pick(ASR_PREFS) || "gpt-transcribe", llm: pick(LLM_PREFS) || ids.find((i) => /^gpt-.*mini/.test(i)) || "gpt-5-mini" };
  S.allModels = ids.filter((i) => /^(gpt|whisper|o\d)/.test(i)).sort();
  S.effortIdx = 0; S.noLangHint = false; saveS();
}

function asrPrompt(course, prev) {
  const parts = [];
  if (course.keywords) parts.push(course.keywords);
  if (prev) parts.push(prev);
  return parts.join(" ").slice(-600);
}
async function transcribe(wavBuf, course, prev) {
  const fd = new FormData();
  fd.append("file", new Blob([wavBuf], { type: "audio/wav" }), "segment.wav");
  fd.append("model", S.models.asr);
  fd.append("response_format", "json");
  const p = asrPrompt(course, prev); if (p) fd.append("prompt", p);
  const lang = course.src !== "auto" ? course.src : null;
  if (lang && !S.noLangHint) {
    if (S.models.asr === "gpt-transcribe") fd.append("languages[]", lang);
    else fd.append("language", lang);
  }
  try {
    const r = await oa("/audio/transcriptions", { method: "POST", body: fd });
    return ((await r.json()).text || "").trim();
  } catch (e) {
    if (e.status === 400 && lang && !S.noLangHint && /language/i.test(e.body)) { S.noLangHint = true; saveS(); return transcribe(wavBuf, course, prev); }
    throw e;
  }
}
async function translate(text, course, ctx) {
  const target = LANG[course.tgt].full;
  const sys = `You are a professional simultaneous interpreter for university lectures. Course: "${course.name}".` +
    (course.keywords ? ` Key names and terms: ${course.keywords}.` : "") +
    ` You receive a live lecture transcript produced by speech recognition, one segment at a time. Translate the NEW segment into ${target}.` +
    ` Speech recognition may contain small errors: silently correct obvious ones using context. Use accurate academic terminology; keep proper names in their standard form.` +
    ` Be faithful and natural; do not summarize, explain or add anything. If the segment is already in ${target}, return it lightly cleaned up. Output only the translation.`;
  const user = (ctx ? `Previous context (for coherence only, do not translate):\n${ctx}\n\n` : "") + `NEW segment:\n${text}`;
  const body = { model: S.models.llm, messages: [{ role: "system", content: sys }, { role: "user", content: user }] };
  const eff = EFFORTS[S.effortIdx];
  if (eff && /^(gpt-5|o\d)/.test(S.models.llm)) body.reasoning_effort = eff;
  try {
    const r = await oa("/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    return (j.choices?.[0]?.message?.content || "").trim();
  } catch (e) {
    if (e.status === 400 && body.reasoning_effort && /reasoning/i.test(e.body) && S.effortIdx < EFFORTS.length - 1) { S.effortIdx++; saveS(); return translate(text, course, ctx); }
    throw e;
  }
}
// Known hallucinations on near-silent audio
const JUNK = /^(sottotitoli|sottotitolato|subtitles? by|thank you for watching|thanks for watching|grazie (a tutti )?per (la visione|l'ascolto)|字幕|请不吝点赞|謝謝觀看|谢谢观看|amara\.org)/i;
const clean = (t) => { t = (t || "").trim(); return !t || (t.length < 60 && JUNK.test(t)) ? "" : t; };

/* ---------------- views ---------------- */
let view = "";
function go(v) {
  view = v;
  document.querySelectorAll(".view").forEach((el) => el.classList.toggle("on", el.id === "v-" + v));
  window.scrollTo(0, 0);
  if (v === "home") renderHome();
}
document.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => go(b.dataset.go)));

/* setup */
$("toSettings").onclick = () => {
  $("keyIn").value = S.key || ""; $("setupBack").classList.remove("hidden");
  $("setupMsg").innerHTML = ""; fillAdvanced(); go("setup");
};
$("setupBack").onclick = () => go("home");
function fillAdvanced() {
  if (!S.key) return;
  $("advanced").classList.remove("hidden");
  $("asrModel").value = S.models.asr || ""; $("llmModel").value = S.models.llm || "";
  $("modelList").innerHTML = (S.allModels || []).map((m) => `<option value="${esc(m)}">`).join("");
}
$("saveKey").onclick = async () => {
  const k = $("keyIn").value.trim();
  if (!k) return;
  S.key = k; $("setupMsg").innerHTML = '<div class="note">正在测试…</div>';
  $("saveKey").disabled = true;
  try {
    await detectModels();
    $("setupMsg").innerHTML = `<div class="ok">✓ 连接成功。语音识别：${esc(S.models.asr)}，翻译：${esc(S.models.llm)}</div>`;
    fillAdvanced();
    setTimeout(() => go("home"), 900);
  } catch (e) {
    $("setupMsg").innerHTML = `<div class="err">${esc(friendly(e))}</div>`;
  } finally { $("saveKey").disabled = false; }
};
$("saveModels").onclick = () => {
  S.models.asr = $("asrModel").value.trim() || S.models.asr;
  S.models.llm = $("llmModel").value.trim() || S.models.llm;
  S.effortIdx = 0; S.noLangHint = false; saveS();
  $("setupMsg").innerHTML = '<div class="ok">✓ 已保存</div>';
};

/* home */
async function renderHome() {
  const courses = (await db.all("courses")).sort((a, b) => (b.last || b.created) - (a.last || a.created));
  const el = $("courses");
  el.innerHTML = courses.map((c) => `<div class="card course" data-id="${c.id}"><b>${esc(c.name)}</b>
    <div><span class="pill">${LANG[c.src].name} → ${LANG[c.tgt].name}</span></div>
    <div class="sub">${c.last ? "上次：" + fmtDate(c.last) : "还没有记录"}</div></div>`).join("") +
    `<div class="card newcourse" id="newCourse">＋ 新建课程</div>`;
  el.querySelectorAll(".course").forEach((d) => (d.onclick = () => openCourse(d.dataset.id)));
  $("newCourse").onclick = () => editCourse(null);
}

/* course editor */
let editing = null;
function editCourse(c) {
  editing = c;
  $("cfTitle").textContent = c ? "编辑课程" : "新建课程";
  $("cfName").value = c?.name || ""; $("cfSrc").value = c?.src || "it"; $("cfTgt").value = c?.tgt || "zh"; $("cfKw").value = c?.keywords || "";
  $("cfDelete").classList.toggle("hidden", !c);
  $("m-course").classList.add("on"); setTimeout(() => $("cfName").focus(), 50);
}
$("cfCancel").onclick = () => $("m-course").classList.remove("on");
$("courseForm").onsubmit = async (e) => {
  e.preventDefault();
  const c = editing || { id: uid(), created: Date.now() };
  Object.assign(c, { name: $("cfName").value.trim(), src: $("cfSrc").value, tgt: $("cfTgt").value, keywords: $("cfKw").value.trim() });
  if (!c.name) return;
  await db.put("courses", c);
  $("m-course").classList.remove("on");
  editing ? openCourse(c.id) : renderHome();
};
$("cfDelete").onclick = async () => {
  if (!editing || !confirm(`删除「${editing.name}」和它的所有上课记录？`)) return;
  for (const s of await db.sessions(editing.id)) await db.del("sessions", s.id);
  await db.del("courses", editing.id);
  $("m-course").classList.remove("on"); go("home");
};

/* course page */
let course = null;
async function openCourse(id) {
  course = await db.get("courses", id);
  if (!course) return go("home");
  $("courseTitle").textContent = course.name;
  $("courseSub").textContent = `${LANG[course.src].name} → ${LANG[course.tgt].name}` + (course.keywords ? ` · 关键词：${course.keywords}` : "");
  const ss = (await db.sessions(id)).sort((a, b) => b.start - a.start);
  $("sessions").innerHTML = ss.length ? ss.map((s) => `<div class="card sess" data-id="${s.id}">
      <div style="flex:1"><b>${fmtDate(s.start)}</b>
      <div class="meta">${fmtT((s.end || s.start) - s.start)} · ${s.segs.filter((x) => x.src).length} 句${s.end ? "" : " · 未正常结束"}</div></div><span class="sub">›</span></div>`).join("")
    : '<div class="empty">还没有上课记录</div>';
  $("sessions").querySelectorAll(".sess").forEach((d) => (d.onclick = () => openSession(d.dataset.id)));
  go("course");
}
$("editCourse").onclick = () => editCourse(course);

/* ---------------- transcript rendering ---------------- */
let cur = null; // { session, course, live:boolean }
function segHTML(s) {
  const ts = `<span class="ts">${fmtT(s.t)}</span>`;
  let src, tr;
  if (s.st === "asr") { src = '<span class="wait">识别中…</span>'; tr = ""; }
  else src = esc(s.src);
  if (s.st === "mt") tr = '<span class="wait">翻译中…</span>';
  else if (s.st === "err") tr = `<span class="wait">${esc(s.err || "失败")}</span><br><button class="btn retry" data-i="${s.i}">重试</button>`;
  else if (s.st !== "asr") tr = esc(s.tr);
  return `<div class="src">${ts}${src}</div><div class="tr">${tr}</div>`;
}
function renderSeg(s) {
  const feed = $("feed");
  let el = feed.querySelector(`[data-i="${s.i}"].seg`);
  if (s.st === "empty") { el && el.remove(); return; }
  const stick = nearBottom();
  if (!el) { el = document.createElement("div"); el.className = "seg"; el.dataset.i = s.i; feed.appendChild(el); }
  el.classList.toggle("err", s.st === "err");
  el.innerHTML = segHTML(s);
  const rb = el.querySelector(".retry"); if (rb) rb.onclick = () => retrySeg(s);
  if (stick) scrollBottom(); else if (cur?.live) $("jump").classList.remove("hidden");
}
const nearBottom = () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
const scrollBottom = () => { window.scrollTo(0, document.body.scrollHeight); $("jump").classList.add("hidden"); };
$("jump").onclick = scrollBottom;
window.addEventListener("scroll", () => { if (nearBottom()) $("jump").classList.add("hidden"); }, { passive: true });

function showTranscript(session, crs, live) {
  cur = { session, course: crs, live };
  $("liveTitle").textContent = crs.name + (live ? "" : " · " + fmtDate(session.start));
  $("colSrc").textContent = "原文 · " + LANG[crs.src].name;
  $("colTr").textContent = "译文 · " + LANG[crs.tgt].name;
  $("feed").innerHTML = ""; $("banners").innerHTML = "";
  session.segs.forEach((s) => s.st !== "empty" && renderSeg(s));
  ["recInd", "meter", "pauseBtn", "stopBtn", "listening"].forEach((id) => $(id).classList.toggle("hidden", !live));
  ["copyBtn", "dlBtn", "delBtn"].forEach((id) => $(id).classList.toggle("hidden", live));
  updateStat();
  go("live");
  if (!live) window.scrollTo(0, 0);
}
function updateStat() {
  if (!cur) return;
  const s = cur.session, dur = (s.end || (cur.live ? Date.now() : s.start)) - s.start;
  const cost = (s.audioSec / 60) * (ASR_PRICE[S.models.asr] || 0.006) * 1.15;
  $("liveStat").textContent = `${fmtT(dur)} · 约 $${cost.toFixed(2)}`;
}
async function openSession(id) { const s = await db.get("sessions", id); if (s) showTranscript(s, course, false); }
$("liveBack").onclick = async () => {
  if (cur?.live) { if (!confirm("结束这节课并保存？")) return; await stopClass(); }
  openCourse(cur.course.id);
};
$("fsUp").onclick = () => { S.fs = Math.min(30, S.fs + 2); document.documentElement.style.setProperty("--fs", S.fs + "px"); saveS(); };
$("fsDown").onclick = () => { S.fs = Math.max(13, S.fs - 2); document.documentElement.style.setProperty("--fs", S.fs + "px"); saveS(); };

function exportText(s, c) {
  const lines = [`${c.name}`, `${fmtDate(s.start)}  ·  ${fmtT((s.end || s.start) - s.start)}`, `${LANG[c.src].name} → ${LANG[c.tgt].name}`, ""];
  s.segs.filter((x) => x.src).forEach((x) => lines.push(`[${fmtT(x.t)}]`, x.src, x.tr || "（未翻译）", ""));
  return lines.join("\n");
}
$("copyBtn").onclick = async () => {
  try { await navigator.clipboard.writeText(exportText(cur.session, cur.course)); $("copyBtn").textContent = "已复制 ✓"; }
  catch (e) { $("copyBtn").textContent = "复制失败"; }
  setTimeout(() => ($("copyBtn").textContent = "复制全部"), 1500);
};
$("dlBtn").onclick = () => {
  const blob = new Blob([exportText(cur.session, cur.course)], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  const d = new Date(cur.session.start);
  a.download = `${cur.course.name} ${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}.txt`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
$("delBtn").onclick = async () => {
  if (!confirm("删除这节课的记录？")) return;
  await db.del("sessions", cur.session.id); openCourse(cur.course.id);
};

/* ---------------- live class ---------------- */
let A = null;          // audio state
let blobs = {};        // seg index -> wav ArrayBuffer (kept until processed)
let saveT = null, statT = null, wakeLock = null, retryT = null;
const saveSession = () => { clearTimeout(saveT); saveT = setTimeout(() => cur && db.put("sessions", cur.session), 400); };

$("startClass").onclick = startClass;
async function startClass() {
  if (!S.key) return go("setup");
  if (!navigator.mediaDevices?.getUserMedia) return alert("这个浏览器不支持录音。请用 iPad 上的 Safari 打开。");
  // AudioContext must be created inside the tap
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  ctx.resume().catch(() => {});   // must be called synchronously inside the tap on iOS
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  } catch (e) {
    ctx.close();
    return alert("没有麦克风权限。请在「设置 → Safari → 麦克风」里允许，或者在地址栏左边的 ᴀA 菜单里允许本网站使用麦克风。");
  }
  await ctx.resume().catch(() => {});
  const session = { id: uid(), courseId: course.id, start: Date.now(), end: null, segs: [], audioSec: 0 };
  blobs = {};
  await db.put("sessions", session);
  course.last = session.start; db.put("courses", course);
  showTranscript(session, course, true);
  A = { ctx, stream, paused: false };
  wireAudio();
  statT = setInterval(() => { updateStat(); $("meter").firstChild.style.width = Math.min(100, (A?.seg?.level || 0) * 900) + "%"; }, 120);
  acquireWake();
  $("pauseBtn").textContent = "暂停"; $("recInd").classList.remove("paused"); $("recText").textContent = "录音中";
}
function wireAudio() {
  const { ctx, stream } = A;
  A.srcNode = ctx.createMediaStreamSource(stream);
  A.proc = ctx.createScriptProcessor(4096, 1, 1);
  A.mute = ctx.createGain(); A.mute.gain.value = 0;
  A.srcNode.connect(A.proc); A.proc.connect(A.mute); A.mute.connect(ctx.destination);
  const offset = Date.now() - cur.session.start;
  A.seg = new Segmenter(ctx.sampleRate, onSegment);
  A.seg.clock = offset; A.seg.reset();
  A.proc.onaudioprocess = (e) => { if (!A || A.paused) return; A.seg.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
  stream.getAudioTracks()[0].onended = () => { if (A && cur?.live) recoverAudio("麦克风被系统中断了"); };
}
function onSegment(f32, durMs, startMs) {
  const wav = encodeWav(downsample(f32, A.ctx.sampleRate, 16000), 16000);
  const s = { i: cur.session.segs.length, t: Math.max(0, startMs), dur: durMs, src: "", tr: "", st: "asr" };
  cur.session.segs.push(s); blobs[s.i] = wav;
  renderSeg(s); saveSession(); processSeg(s, cur);
}
function prevSrc(sess, i, n) {
  let out = "";
  for (let j = i - 1; j >= 0 && out.length < n; j--) if (sess.segs[j].src) out = sess.segs[j].src + " " + out;
  return out.trim().slice(-n);
}
async function processSeg(s, ctxCur) {
  const { session, course: crs } = ctxCur;
  const visible = () => cur && cur.session === session;
  try {
    if (!s.src) {
      s.st = "asr"; visible() && renderSeg(s);
      const text = clean(await transcribe(blobs[s.i], crs, prevSrc(session, s.i, 300)));
      session.audioSec += s.dur / 1000;
      if (!text) { s.st = "empty"; delete blobs[s.i]; visible() && renderSeg(s); saveSession(); return; }
      s.src = text;
    }
    s.st = "mt"; s.err = ""; visible() && renderSeg(s); saveSession();
    s.tr = await translate(s.src, crs, prevSrc(session, s.i, 500));
    s.st = "ok"; delete blobs[s.i];
  } catch (e) {
    s.st = "err"; s.err = friendly(e);
    if (e.status === 401) banner("API Key 无效，请到设置里重新填写。");
    if (e.status !== 401 && !(e.status === 429 && /quota|billing/i.test(e.body))) scheduleRetry();
  }
  visible() && renderSeg(s); saveSession(); visible() && updateStat();
}
function retrySeg(s) {
  if (!s.src && !blobs[s.i]) { s.err = "这段录音已丢失（页面曾被关闭）"; renderSeg(s); return; }
  processSeg(s, cur);
}
function scheduleRetry() {
  clearTimeout(retryT);
  retryT = setTimeout(() => {
    if (!cur?.live) return;
    cur.session.segs.filter((s) => s.st === "err" && (s.tries = (s.tries || 0) + 1) <= 5).forEach((s) => retrySeg(s));
  }, 6000);
}
window.addEventListener("online", () => cur?.live && cur.session.segs.filter((s) => s.st === "err").forEach((s) => retrySeg(s)));

$("pauseBtn").onclick = () => {
  if (!A) return;
  A.paused = !A.paused;
  if (A.paused) A.seg.flush();
  else { A.seg.clock = Date.now() - cur.session.start; A.seg.reset(); }
  $("pauseBtn").textContent = A.paused ? "继续" : "暂停";
  $("recInd").classList.toggle("paused", A.paused);
  $("recText").textContent = A.paused ? "已暂停" : "录音中";
  $("listening").classList.toggle("hidden", A.paused);
};
$("stopBtn").onclick = async () => { await stopClass(); showTranscript(cur.session, cur.course, false); };
async function stopClass() {
  if (!cur?.live) return;
  if (A) {
    try { A.seg.flush(); } catch (e) {}
    try { A.proc.disconnect(); A.srcNode.disconnect(); } catch (e) {}
    A.stream.getTracks().forEach((t) => t.stop());
    A.ctx.close().catch(() => {});
    A = null;
  }
  clearInterval(statT); releaseWake();
  cur.session.end = Date.now();
  cur.live = false;
  // let in-flight segments finish in the background; they still save to this session
  await db.put("sessions", cur.session);
}

/* keep screen on + recover after iPad backgrounding */
async function acquireWake() { try { wakeLock = await navigator.wakeLock?.request("screen"); } catch (e) {} }
function releaseWake() { try { wakeLock?.release(); } catch (e) {} wakeLock = null; }
function banner(msg) {
  const d = document.createElement("div"); d.className = "banner"; d.textContent = msg;
  $("banners").appendChild(d); setTimeout(() => d.remove(), 12000);
}
async function recoverAudio(reason) {
  if (!A || !cur?.live) return;
  try {
    const track = A.stream.getAudioTracks()[0];
    if (!track || track.readyState === "ended") {
      A.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      try { A.proc.disconnect(); A.srcNode.disconnect(); } catch (e) {}
      wireAudio();
    }
    if (A.ctx.state !== "running") await A.ctx.resume();
    banner(`${reason}，已自动恢复录音。中间可能漏了一小段。`);
  } catch (e) {
    banner("录音中断了，请点「结束」后重新开始上课。");
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && cur?.live) { acquireWake(); recoverAudio("刚才切到了后台"); }
});
window.addEventListener("beforeunload", (e) => { if (cur?.live) { db.put("sessions", cur.session); e.preventDefault(); e.returnValue = ""; } });

/* ---------------- boot ---------------- */
(async () => {
  // mark sessions that never ended (page closed mid-class)
  try { for (const s of await db.all("sessions")) if (!s.end && s.segs.length) { s.end = s.start + (s.segs.at(-1).t || 0) + 5000; s.segs.forEach((x) => { if (x.st === "asr" || x.st === "mt") { x.st = x.src ? "err" : "empty"; x.err = "未完成"; } }); db.put("sessions", s); } } catch (e) {}
  if (!S.key) { go("setup"); } else go("home");
})();
