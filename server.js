// fal.ai remote MCP server v7 — reklam videosu otomasyonu
// Görsel/video/ses/müzik/altyazı + proje panosu + model seçimi + yükleme sayfası + ffmpeg birleştirme
// Env: FAL_KEY, MCP_SECRET, PORT (ops.), DATA_DIR (ops., Railway Volume için /data)

import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const FAL_KEY = process.env.FAL_KEY;
const MCP_SECRET = process.env.MCP_SECRET;
const PORT = process.env.PORT || 3000;
const VERSION = "7";

if (!FAL_KEY || !MCP_SECRET) {
  console.error("FAL_KEY ve MCP_SECRET ortam değişkenleri gerekli.");
  process.exit(1);
}
const AUTH = { Authorization: `Key ${FAL_KEY}` };

// ---------- Depolama ----------
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : path.resolve("data"));
const DIRS = {
  projects: path.join(DATA_DIR, "projects"),
  media: path.join(DATA_DIR, "media"),
  fonts: path.join(DATA_DIR, "fonts"),
  tmp: path.join(DATA_DIR, "tmp"),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
const PERSISTENT = DATA_DIR === "/data" || !!process.env.DATA_DIR;

const FONT_FILE = path.join(DIRS.fonts, "Poppins-Bold.ttf");
async function ensureFont() {
  if (fs.existsSync(FONT_FILE)) return;
  try {
    const r = await fetch("https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-Bold.ttf");
    if (r.ok) await fsp.writeFile(FONT_FILE, Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error("Font indirilemedi:", e.message);
  }
}
ensureFont();

const rid = (n = 6) => crypto.randomBytes(n).toString("hex");
const safeName = (s) => String(s || "dosya").replace(/[^\w.\-]/g, "_").slice(0, 80);

// ---------- Kısayollar ----------
const MODELS = {
  "flux-dev": "fal-ai/flux/dev",
  "flux-schnell": "fal-ai/flux/schnell",
  "nano-banana": "fal-ai/nano-banana",
  "nano-banana-edit": "fal-ai/nano-banana/edit",
  "nano-banana-2": "fal-ai/nano-banana-2",
  "nano-banana-pro": "fal-ai/nano-banana-pro",
  "seedream": "fal-ai/bytedance/seedream/v4/text-to-image",
  "seedream-edit": "fal-ai/bytedance/seedream/v4/edit",
  "gpt-image-2.5": "openai/gpt-image-2.5/flare/text-to-image",
  "h3-turbo-i2v": "minimax/h3-max-turbo/image-to-video",
  "seedance-2.5-i2v": "bytedance/seedance-2.5/image-to-video",
  "seedance-2.5-t2v": "bytedance/seedance-2.5/text-to-video",
  "seedance-2-i2v": "bytedance/seedance-2.0/image-to-video",
  "kling-3-i2v": "fal-ai/kling-video/o3/standard/image-to-video",
  "veo-3.1": "fal-ai/veo3.1",
  "minimax-speech-hd": "fal-ai/minimax/speech-2.8-hd",
  "minimax-speech-turbo": "fal-ai/minimax/speech-2.6-turbo",
  "elevenlabs-tts": "fal-ai/elevenlabs/tts/multilingual-v2",
  "elevenlabs-music": "elevenlabs/music/v2",
  "minimax-music": "fal-ai/minimax-music/v2",
  "lyria2": "fal-ai/lyria2",
  "whisper": "fal-ai/whisper",
  "elevenlabs-stt": "fal-ai/elevenlabs/speech-to-text",
};
const resolveModel = (m) => MODELS[m] || m;

// ---------- Fiyat ----------
const PRICE_TABLE = {
  "fal-ai/flux/dev": { unit: "mp", price: 0.025 },
  "fal-ai/nano-banana": { unit: "image", price: 0.039 },
  "fal-ai/nano-banana-2": { unit: "image", price: 0.08 },
  "fal-ai/nano-banana-pro": { unit: "image", price: 0.15 },
  "fal-ai/minimax/speech-2.8-hd": { unit: "kchar", price: 0.1 },
  "fal-ai/minimax/speech-2.6-turbo": { unit: "kchar", price: 0.06 },
  "fal-ai/elevenlabs/tts/multilingual-v2": { unit: "kchar", price: 0.1 },
  "elevenlabs/music/v2": { unit: "minute_ceil", price: 0.6 },
  "fal-ai/minimax-music/v2": { unit: "request", price: 0.03 },
  "fal-ai/elevenlabs/speech-to-text": { unit: "minute", price: 0.03 },
};
function normUnit(u) {
  const s = String(u || "").toLowerCase();
  if (s.includes("char")) return s.includes("1000") || s.includes("1k") || s.includes("thousand") ? "kchar" : "char";
  if (s.includes("second") || s === "s" || s === "sec") return "second";
  if (s.includes("minute")) return "minute";
  if (s.includes("mega") || s.includes("mp")) return "mp";
  if (s.includes("token")) return "token";
  if (s.includes("image")) return "image";
  if (s.includes("video")) return "video";
  return "request";
}
const priceCache = new Map();
async function fetchPrices(ids) {
  const need = ids.filter((id) => !priceCache.has(id));
  if (need.length) {
    try {
      const qs = need.map((id) => `endpoint_id=${encodeURIComponent(id)}`).join("&");
      const r = await fetch(`https://api.fal.ai/v1/models/pricing?${qs}`, { headers: AUTH });
      if (r.ok) {
        const j = await r.json();
        for (const p of j.prices || j.data || []) {
          if (p && p.endpoint_id && typeof p.unit_price === "number")
            priceCache.set(p.endpoint_id, { unit: normUnit(p.unit), raw_unit: p.unit, price: p.unit_price, source: "fal" });
        }
      }
    } catch {}
    for (const id of need) if (!priceCache.has(id)) priceCache.set(id, PRICE_TABLE[id] ? { ...PRICE_TABLE[id], source: "tablo" } : null);
  }
  const out = {};
  for (const id of ids) out[id] = priceCache.get(id) || null;
  return out;
}
const getPrice = async (id) => (await fetchPrices([id]))[id];
function estimateCost(price, ctx) {
  if (!price) return null;
  const media = ctx.media || [];
  const visual = media.filter((m) => m.type === "image" || m.type === "video");
  const n = Math.max(1, visual.length || media.length || 1);
  const dur = ctx.durationSec || null;
  switch (price.unit) {
    case "image":
    case "video":
      return price.price * n;
    case "request":
      return price.price;
    case "mp":
      return visual.reduce((s, m) => s + Math.max(1, Math.ceil(m.width && m.height ? (m.width * m.height) / 1e6 : 1)) * price.price, 0) || price.price;
    case "second":
      return dur ? price.price * dur * n : null;
    case "minute":
      return dur ? price.price * (dur / 60) : null;
    case "minute_ceil":
      return dur ? price.price * Math.ceil(dur / 60) : price.price;
    case "kchar":
      return ctx.chars ? price.price * (ctx.chars / 1000) : null;
    case "char":
      return ctx.chars ? price.price * ctx.chars : null;
    default:
      return null;
  }
}

// ---------- Geçici metin dosyaları (SRT/VTT) ----------
const files = new Map();
function storeFile(body, name, mime) {
  const id = rid(12);
  files.set(id, { body, name, mime, exp: Date.now() + 24 * 3600 * 1000 });
  for (const [k, v] of files) if (v.exp < Date.now()) files.delete(k);
  return id;
}

// ---------- Projeler ----------
const pPath = (id) => path.join(DIRS.projects, `${safeName(id)}.json`);
async function loadProject(id) {
  try {
    return JSON.parse(await fsp.readFile(pPath(id), "utf8"));
  } catch {
    throw new Error(`Proje bulunamadı: ${id}`);
  }
}
async function saveProject(p) {
  p.updated_at = new Date().toISOString();
  await fsp.writeFile(pPath(p.id), JSON.stringify(p, null, 2));
  return p;
}
const newAsset = () => ({ candidates: [], chosen: null });
function newScene(f = {}) {
  return {
    id: rid(4),
    title: f.title || "",
    duration: f.duration || null,
    description: f.description || "",
    voiceover: f.voiceover || "",
    onscreen_text: f.onscreen_text || "",
    image_prompt: f.image_prompt || "",
    video_prompt: f.video_prompt || "",
    image: newAsset(),
    video: newAsset(),
  };
}
const FORMATS = { "9:16": [1080, 1920], "16:9": [1920, 1080], "1:1": [1080, 1080], "4:5": [1080, 1350] };
const STAGES = [
  ["brief", "Brief"],
  ["storyboard", "Storyboard"],
  ["images", "Görseller"],
  ["videos", "Videolar"],
  ["audio", "Ses"],
  ["render", "Birleştirme"],
  ["final", "Final"],
];
function computeStage(p) {
  if (!p.scenes.length) return "storyboard";
  if (!p.storyboard_approved) return "storyboard";
  if (p.scenes.some((s) => !s.image.chosen && !s.video.chosen)) return "images";
  if (p.scenes.some((s) => !s.video.chosen)) return "videos";
  const needsVo = p.scenes.some((s) => s.voiceover);
  if ((needsVo && !p.audio.voiceover.chosen) || (p.wants_music !== false && !p.audio.music.chosen)) return "audio";
  if (!p.renders.length) return "render";
  return "final";
}
function projectView(p, baseUrl) {
  const stage = computeStage(p);
  return {
    view: "project",
    project: {
      id: p.id,
      name: p.name,
      app: p.app,
      concept: p.concept,
      format: p.format,
      target_duration: p.target_duration,
      models: p.models,
      stage,
      stages: STAGES,
      storyboard_approved: !!p.storyboard_approved,
      total_duration: p.scenes.reduce((s, x) => s + (Number(x.duration) || 0), 0),
      scenes: p.scenes.map((s, i) => ({ n: i + 1, ...s })),
      audio: p.audio,
      subtitle: p.subtitle ? { segments: (p.subtitle.cues || []).length, enabled: p.subtitle.enabled !== false } : null,
      renders: p.renders.slice(-3).map((r) => ({ ...r, download_url: `${baseUrl}/media-dl/${r.file}`, url: `${baseUrl}/media/${r.file}` })),
      spent_usd: Math.round((p.spent_usd || 0) * 1000) / 1000,
      persistent: PERSISTENT,
    },
  };
}
function projectResult(p, baseUrl, note) {
  const v = projectView(p, baseUrl);
  const summary = {
    project_id: p.id,
    stage: v.project.stage,
    note: note || null,
    scenes: v.project.scenes.map((s) => ({
      n: s.n,
      title: s.title,
      duration: s.duration,
      image: s.image.chosen ? "onaylı" : `${s.image.candidates.length} aday`,
      video: s.video.chosen ? "onaylı" : `${s.video.candidates.length} aday`,
    })),
    voiceover: p.audio.voiceover.chosen ? "onaylı" : `${p.audio.voiceover.candidates.length} aday`,
    music: p.audio.music.chosen ? "onaylı" : `${p.audio.music.candidates.length} aday`,
    last_render: v.project.renders.length ? v.project.renders[v.project.renders.length - 1].url : null,
  };
  return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }], structuredContent: v };
}

async function attachToProject(att, media, meta) {
  if (!att || !att.project_id) return null;
  const p = await loadProject(att.project_id);
  const kind = att.kind;
  const pick = (m) =>
    (kind === "image" && m.type === "image") ||
    (kind === "video" && m.type === "video") ||
    ((kind === "voiceover" || kind === "music") && (m.type === "audio" || m.type === "video"));
  const items = media.filter(pick).map((m) => ({ url: m.url, model: meta.model, prompt: meta.prompt || "", at: new Date().toISOString() }));
  if (!items.length) return null;
  if (kind === "image" || kind === "video") {
    const s = p.scenes[(att.scene || 0) - 1];
    if (!s) throw new Error(`Sahne ${att.scene} yok`);
    s[kind].candidates.push(...items);
  } else {
    p.audio[kind].candidates.push(...items);
    if (kind === "voiceover" && meta.durationSec) items.forEach((i) => (i.duration = meta.durationSec));
  }
  if (meta.cost) p.spent_usd = (p.spent_usd || 0) + meta.cost;
  await saveProject(p);
  return items.length;
}

// ---------- fal kuyruk ----------
const jobs = new Map();
async function submitFal(modelId, input) {
  const r = await fetch(`https://queue.fal.run/${modelId}`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(`fal submit hatası ${r.status}: ${await r.text()}`);
  return r.json();
}
function queueUrls(modelId, requestId) {
  const base = modelId.split("/").slice(0, 2).join("/");
  return {
    status_url: `https://queue.fal.run/${base}/requests/${requestId}/status`,
    response_url: `https://queue.fal.run/${base}/requests/${requestId}`,
  };
}
async function waitFal(status_url, response_url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st = await (await fetch(status_url, { headers: AUTH })).json();
    if (st.status === "COMPLETED") {
      const res = await fetch(response_url, { headers: AUTH });
      if (!res.ok) throw new Error(`fal sonuç hatası ${res.status}: ${await res.text()}`);
      return res.json();
    }
    if (st.status === "FAILED" || st.error) throw new Error(`fal işi başarısız: ${JSON.stringify(st)}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

// ---------- Sonuç ayrıştırma ----------
function classify(f) {
  const ct = String(f.content_type || "").toLowerCase();
  const u = String(f.url || "").toLowerCase().split("?")[0];
  if (ct.startsWith("image") || /\.(png|jpe?g|webp|gif|avif)$/.test(u)) return "image";
  if (ct.startsWith("video") || /\.(mp4|webm|mov|m4v)$/.test(u)) return "video";
  if (ct.startsWith("audio") || /\.(mp3|wav|ogg|flac|m4a|aac)$/.test(u)) return "audio";
  if (/\.(glb|gltf|obj|fbx|usdz|ply|stl)$/.test(u)) return "3d";
  return "file";
}
function dlUrl(url, baseUrl) {
  if (!baseUrl) return url;
  if (url.startsWith(`${baseUrl}/media/`)) return url.replace("/media/", "/media-dl/");
  return `${baseUrl}/dl?url=${encodeURIComponent(url)}`;
}
function extractMedia(result, baseUrl) {
  const media = [];
  const seen = new Set();
  const walk = (v, d) => {
    if (!v || d > 5) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, d + 1));
    if (typeof v !== "object") return;
    if (typeof v.url === "string" && /^https?:\/\//.test(v.url) && !seen.has(v.url)) {
      seen.add(v.url);
      media.push({ type: classify(v), url: v.url, width: v.width || null, height: v.height || null, name: v.file_name || null, download_url: dlUrl(v.url, baseUrl) });
      return;
    }
    for (const k of Object.keys(v)) walk(v[k], d + 1);
  };
  walk(result, 0);
  return media;
}
function mediaDuration(result) {
  const ms = result?.duration_ms ?? result?.audio?.duration_ms;
  if (typeof ms === "number") return ms / 1000;
  const s = result?.duration ?? result?.audio?.duration ?? result?.video?.duration;
  return typeof s === "number" ? s : null;
}

async function buildResult(result, modelId, prompt, baseUrl, ctx = {}) {
  const media = extractMedia(result, baseUrl);
  const durationSec = ctx.durationSec || mediaDuration(result);
  const price = await getPrice(modelId);
  const cost = estimateCost(price, { ...ctx, media, durationSec });
  let attached = null;
  if (ctx.attach) {
    try {
      attached = await attachToProject(ctx.attach, media, { model: modelId, prompt, durationSec, cost });
    } catch (e) {
      attached = `hata: ${e.message}`;
    }
  }
  const structured = {
    view: "media",
    status: "done",
    model: modelId,
    prompt: prompt || "",
    media,
    images: media.filter((m) => m.type === "image"),
    text: ctx.text || (typeof result?.text === "string" ? result.text : null),
    subtitle: ctx.subtitle || null,
    attach: ctx.attach ? { ...ctx.attach, added: attached } : null,
    cost_usd: cost !== null ? Math.round(cost * 10000) / 10000 : null,
    cost_source: price ? price.source : null,
    price_unit: price ? `${price.price} USD / ${price.raw_unit || price.unit}` : null,
  };
  if (!media.length && !structured.text) structured.raw = JSON.stringify(result).slice(0, 4000);
  const forClaude = { ...structured, subtitle: structured.subtitle ? { ...structured.subtitle, srt: (structured.subtitle.srt || "").slice(0, 3000), cues: undefined } : null };
  const content = [{ type: "text", text: JSON.stringify(forClaude, null, 2) }];
  for (const im of media.filter((m) => m.type === "image").slice(0, 4)) {
    try {
      const r = await fetch(im.url);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 4.5 * 1024 * 1024) continue;
      content.push({ type: "image", data: buf.toString("base64"), mimeType: r.headers.get("content-type") || "image/png" });
    } catch {}
  }
  return { content, structuredContent: structured };
}
function pendingResult(model, requestId, prompt) {
  const s = { view: "media", status: "pending", model, request_id: requestId, prompt: prompt || "", media: [], note: "Hâlâ hazırlanıyor. Birkaç saniye sonra check_job ile bu request_id'yi sorgula." };
  return { content: [{ type: "text", text: JSON.stringify(s, null, 2) }], structuredContent: s };
}
const errResult = (e) => ({ isError: true, content: [{ type: "text", text: String(e?.message || e) }] });

async function runAndRender({ modelId, input, prompt, baseUrl, ctx, waitMs, kind }) {
  const sub = await submitFal(modelId, input);
  jobs.set(sub.request_id, { modelId, status_url: sub.status_url, response_url: sub.response_url, prompt, ctx, kind });
  const res = await waitFal(sub.status_url, sub.response_url, waitMs);
  if (!res) return pendingResult(modelId, sub.request_id, prompt);
  jobs.delete(sub.request_id);
  return finalize(res, { modelId, prompt, baseUrl, ctx, kind });
}
async function finalize(res, { modelId, prompt, baseUrl, ctx = {}, kind }) {
  if (kind === "transcribe") {
    const sub = toSubtitle(res, ctx.maxWords || 5);
    const subtitle = {
      srt: sub.srt,
      srt_url: `${baseUrl}/file/${storeFile(sub.srt, "altyazi.srt", "application/x-subrip")}`,
      vtt_url: `${baseUrl}/file/${storeFile(sub.vtt, "altyazi.vtt", "text/vtt")}`,
      segments: sub.cues.length,
    };
    if (ctx.project_id) {
      const p = await loadProject(ctx.project_id);
      p.subtitle = { cues: sub.cues, enabled: true, source: ctx.media_url, style: p.subtitle?.style || {} };
      await saveProject(p);
      subtitle.saved_to_project = p.id;
    }
    return buildResult(res, modelId, prompt, baseUrl, { ...ctx, text: sub.text, subtitle, durationSec: sub.duration || ctx.durationSec });
  }
  return buildResult(res, modelId, prompt, baseUrl, ctx);
}

// ---------- Altyazı ----------
function fmtTime(t, sep) {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  return `${h}:${m}:${s}${sep}${String(ms % 1000).padStart(3, "0")}`;
}
function toSubtitle(res, maxWords) {
  let cues = [];
  const words = (res.words || []).filter((w) => (w.type ? w.type === "word" : true) && typeof w.start === "number");
  if (words.length) {
    let cur = [];
    const flush = () => {
      if (cur.length) cues.push({ s: cur[0].start, e: cur[cur.length - 1].end, t: cur.map((x) => String(x.text || x.word).trim()).join(" ") });
      cur = [];
    };
    for (const w of words) {
      cur.push(w);
      if (cur.length >= maxWords || /[.!?…,]$/.test(String(w.text || w.word))) flush();
    }
    flush();
  } else if (Array.isArray(res.chunks) && res.chunks.length) {
    for (const c of res.chunks) {
      const [s, e] = c.timestamp || [];
      if (typeof s !== "number") continue;
      const end = typeof e === "number" ? e : s + 2;
      const ws = String(c.text || "").trim().split(/\s+/).filter(Boolean);
      // uzun segmentleri eşit zamanlı parçalara böl
      const parts = Math.max(1, Math.ceil(ws.length / maxWords));
      for (let i = 0; i < parts; i++) {
        const seg = ws.slice(i * maxWords, (i + 1) * maxWords);
        cues.push({ s: s + ((end - s) * i) / parts, e: s + ((end - s) * (i + 1)) / parts, t: seg.join(" ") });
      }
    }
  }
  if (!cues.length && res.text) cues.push({ s: 0, e: 5, t: String(res.text).trim() });
  cues = cues.filter((c) => c.t);
  const srt = cues.map((c, i) => `${i + 1}\n${fmtTime(c.s, ",")} --> ${fmtTime(c.e, ",")}\n${c.t}\n`).join("\n");
  const vtt = "WEBVTT\n\n" + cues.map((c) => `${fmtTime(c.s, ".")} --> ${fmtTime(c.e, ".")}\n${c.t}\n`).join("\n");
  return { cues, srt, vtt, text: res.text || cues.map((c) => c.t).join(" "), duration: cues.length ? cues[cues.length - 1].e : null };
}
function assTime(t) {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = String(Math.floor((cs % 360000) / 6000)).padStart(2, "0");
  const s = String(Math.floor((cs % 6000) / 100)).padStart(2, "0");
  return `${h}:${m}:${s}.${String(cs % 100).padStart(2, "0")}`;
}
function hexToAss(hex, alpha = "00") {
  const h = String(hex || "#FFFFFF").replace("#", "").padStart(6, "0");
  return `&H${alpha}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}
function buildAss(cues, W, H, style = {}, offset = 0) {
  const size = Math.round(H * (style.size || 0.055));
  const pos = style.position || "bottom";
  const align = pos === "center" ? 5 : pos === "top" ? 8 : 2;
  const marginV = pos === "bottom" ? Math.round(H * (style.margin || 0.2)) : Math.round(H * 0.08);
  const upper = style.uppercase !== false;
  const esc = (t) => String(t).replace(/\\/g, "\\\\").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\n/g, "\\N");
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Poppins,${size},${hexToAss(style.color || "#FFFFFF")},&H000000FF,${hexToAss(style.outline_color || "#000000")},&H64000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(size / 11))},0,${align},${Math.round(W * 0.08)},${Math.round(W * 0.08)},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${cues
  .map((c) => `Dialogue: 0,${assTime(c.s + offset)},${assTime(c.e + offset)},Default,,0,0,0,,${esc(upper ? c.t.toLocaleUpperCase("tr-TR") : c.t)}`)
  .join("\n")}
`;
}

// ---------- ffmpeg ----------
function runFfmpeg(args, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ["-hide_banner", "-y", ...args]);
    let err = "";
    p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-20000)));
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("close", (code) => {
      clearTimeout(t);
      code === 0 ? resolve(err) : reject(new Error(`ffmpeg hata (${code}): ${err.slice(-1500)}`));
    });
    p.on("error", reject);
  });
}
async function probe(file) {
  const out = await new Promise((resolve) => {
    const p = spawn(ffmpegPath, ["-hide_banner", "-i", file]);
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", () => resolve(err));
    p.on("error", () => resolve(""));
  });
  const m = out.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  const dur = m ? +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]) : null;
  return { duration: dur, hasAudio: /Stream #\d+:\d+.*Audio:/.test(out), hasVideo: /Stream #\d+:\d+.*Video:/.test(out) };
}
async function download(url, dest, baseUrl) {
  if (baseUrl && url.startsWith(`${baseUrl}/media/`)) {
    await fsp.copyFile(path.join(DIRS.media, path.basename(url.split("?")[0])), dest);
    return dest;
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`İndirilemedi (${r.status}): ${url}`);
  await fsp.writeFile(dest, Buffer.from(await r.arrayBuffer()));
  return dest;
}
const extOf = (url, def) => {
  const m = String(url).split("?")[0].match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : def;
};

async function renderProject(p, baseUrl, opt) {
  const [W, H] = FORMATS[p.format] || FORMATS["9:16"];
  const work = path.join(DIRS.tmp, `r-${p.id}-${rid(3)}`);
  await fsp.mkdir(work, { recursive: true });
  try {
    const args = [];
    const filters = [];
    const vLabels = [];
    const aLabels = [];
    let idx = 0;
    let total = 0;
    const keepSceneAudio = !!opt.keep_scene_audio;
    for (let i = 0; i < p.scenes.length; i++) {
      const s = p.scenes[i];
      const src = s.video.chosen?.url || s.image.chosen?.url;
      if (!src) throw new Error(`Sahne ${i + 1} için onaylı görsel/video yok`);
      const isVideo = !!s.video.chosen;
      const file = await download(src, path.join(work, `s${i}.${extOf(src, isVideo ? "mp4" : "png")}`), baseUrl);
      const info = isVideo ? await probe(file) : { duration: null, hasAudio: false };
      let dur = Number(s.duration) || info.duration || 3;
      if (isVideo && info.duration) dur = Math.min(dur, info.duration);
      dur = Math.max(0.5, dur);
      total += dur;
      if (isVideo) args.push("-t", dur.toFixed(3), "-i", file);
      else args.push("-loop", "1", "-t", dur.toFixed(3), "-i", file);
      const zoom = isVideo ? "" : `,zoompan=z='min(zoom+0.0008,1.08)':d=${Math.ceil(dur * 30)}:s=${W}x${H}:fps=30`;
      filters.push(`[${idx}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}${zoom},fps=30,setsar=1,format=yuv420p,trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
      vLabels.push(`[v${i}]`);
      if (keepSceneAudio) {
        if (info.hasAudio) filters.push(`[${idx}:a]aresample=44100,aformat=channel_layouts=stereo,atrim=duration=${dur.toFixed(3)},apad=whole_dur=${dur.toFixed(3)},asetpts=PTS-STARTPTS,volume=${opt.scene_audio_volume ?? 0.6}[sa${i}]`);
        else filters.push(`anullsrc=r=44100:cl=stereo,atrim=duration=${dur.toFixed(3)}[sa${i}]`);
      }
      idx++;
    }
    if (keepSceneAudio) {
      filters.push(`${p.scenes.map((_, i) => `[v${i}][sa${i}]`).join("")}concat=n=${p.scenes.length}:v=1:a=1[vcat][scat]`);
      aLabels.push("[scat]");
    } else {
      filters.push(`${vLabels.join("")}concat=n=${p.scenes.length}:v=1:a=0[vcat]`);
    }

    // Altyazı
    let vOut = "[vcat]";
    if (opt.subtitles !== false && p.subtitle?.cues?.length && p.subtitle.enabled !== false) {
      const assFile = path.join(work, "sub.ass");
      await fsp.writeFile(assFile, buildAss(p.subtitle.cues, W, H, { ...(p.subtitle.style || {}), ...(opt.subtitle_style || {}) }, opt.voiceover_offset || 0));
      filters.push(`[vcat]subtitles=filename=${assFile}:fontsdir=${DIRS.fonts}[vsub]`);
      vOut = "[vsub]";
    }

    // Dış ses + müzik (ducking)
    const vo = p.audio.voiceover.chosen;
    const mu = p.audio.music.chosen;
    let voLabel = null;
    if (vo) {
      const f = await download(vo.url, path.join(work, `vo.${extOf(vo.url, "mp3")}`), baseUrl);
      args.push("-i", f);
      const off = Math.round((opt.voiceover_offset || 0) * 1000);
      filters.push(`[${idx}:a]aresample=44100,aformat=channel_layouts=stereo,volume=${opt.voiceover_volume ?? 1.0},adelay=${off}|${off}[vo]`);
      idx++;
      if (mu) {
        filters.push(`[vo]asplit=2[vo1][vo2]`);
        voLabel = "[vo1]";
      } else voLabel = "[vo]";
      aLabels.push(voLabel);
    }
    if (mu) {
      const f = await download(mu.url, path.join(work, `mu.${extOf(mu.url, "mp3")}`), baseUrl);
      args.push("-stream_loop", "-1", "-i", f);
      const fadeStart = Math.max(0, total - 1.5).toFixed(2);
      filters.push(`[${idx}:a]aresample=44100,aformat=channel_layouts=stereo,volume=${opt.music_volume ?? 0.3},atrim=duration=${total.toFixed(3)},afade=t=out:st=${fadeStart}:d=1.5[mu0]`);
      idx++;
      if (vo) {
        filters.push(`[mu0][vo2]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[mu]`);
        aLabels.push("[mu]");
      } else aLabels.push("[mu0]");
    }
    let aOut = null;
    if (aLabels.length === 1) aOut = aLabels[0];
    else if (aLabels.length > 1) {
      filters.push(`${aLabels.join("")}amix=inputs=${aLabels.length}:duration=longest:normalize=0,alimiter=limit=0.95[aout]`);
      aOut = "[aout]";
    }

    const outName = `render-${safeName(p.id)}-${Date.now()}.mp4`;
    const outFile = path.join(DIRS.media, outName);
    const finalArgs = [...args, "-filter_complex", filters.join(";"), "-map", vOut];
    if (aOut) finalArgs.push("-map", aOut, "-c:a", "aac", "-b:a", "192k");
    finalArgs.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30", "-t", total.toFixed(3), "-movflags", "+faststart", outFile);
    await runFfmpeg(finalArgs);
    const rec = { file: outName, at: new Date().toISOString(), duration: Math.round(total * 10) / 10, format: p.format, subtitles: vOut === "[vsub]", options: opt };
    return rec;
  } finally {
    fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
const renderJobs = new Map(); // id -> { promise, status, result, error, project_id }

// ---------- Arayüz (MCP Apps) ----------
const UI_URI = `ui://fal/app-v${VERSION}.html`;
const UI_MIME = "text/html;profile=mcp-app";

const APP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;--card:rgba(127,127,127,.08);--line:rgba(127,127,127,.25);--muted:rgba(127,127,127,1);--acc:#6d5bd0;--ok:#1d9e75}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,sans-serif;background:transparent;color:CanvasText}
.wrap{padding:8px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.card{border:1px solid var(--line);border-radius:12px;padding:10px;background:var(--card)}.wide{grid-column:1/-1}
.card img,.card video{width:100%;display:block;border-radius:8px;background:#000}.card audio{width:100%;display:block}
.meta{display:flex;justify-content:space-between;align-items:center;margin-top:8px;gap:8px;flex-wrap:wrap}
.model{font-weight:600;font-size:13px}.muted{font-size:12px;color:var(--muted)}.cost{font-weight:600}
button{font:inherit;font-size:13px;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer}
button:hover{background:var(--card)}button.primary{background:var(--acc);border-color:var(--acc);color:#fff}button.primary:hover{opacity:.9}
button:disabled{opacity:.5;cursor:default}
input,textarea{font:inherit;font-size:13px;padding:6px 8px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit}
input{flex:1;min-width:0}textarea{width:100%;min-height:120px;font:12px ui-monospace,monospace;resize:vertical}
.foot{margin-top:10px;font-size:12px;color:var(--muted)}.wait{padding:24px;text-align:center;color:var(--muted)}
.tag{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.tag.ok{border-color:var(--ok);color:var(--ok)}.tag.acc{border-color:var(--acc);color:var(--acc)}
.steps{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 12px}.step{font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.step.done{color:var(--ok);border-color:var(--ok)}.step.cur{background:var(--acc);border-color:var(--acc);color:#fff}
.scene{display:grid;grid-template-columns:120px 1fr;gap:12px;align-items:start}
.thumb{width:120px;aspect-ratio:9/16;border-radius:8px;background:rgba(127,127,127,.2);overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--muted)}
.thumb img,.thumb video{width:100%;height:100%;object-fit:cover}
.cands{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}.cands img,.cands video{width:54px;height:54px;object-fit:cover;border-radius:6px;cursor:pointer;border:2px solid transparent}
.cands .sel{border-color:var(--ok)}
.opt{cursor:default}.opt.sel{outline:2px solid var(--acc)}
.toast{margin-top:8px;font-size:12px;padding:8px;border-radius:8px;border:1px dashed var(--line)}
h3{margin:0;font-size:16px}
</style></head>
<body><div class="wrap" id="app"><div class="wait">Yükleniyor…</div></div><div id="toast"></div>
<script>
let nextId = 1; const pending = {};
function send(msg){ window.parent.postMessage(msg, "*"); }
function request(method, params){ const id = nextId++; send({jsonrpc:"2.0", id, method, params}); return new Promise(r => pending[id] = r); }
function notify(method, params){ send({jsonrpc:"2.0", method, params}); }
function openLink(url){ try{ request("ui/open-link", {url}); }catch(e){} try{ window.open(url, "_blank", "noopener"); }catch(e){} }
function reportSize(){ notify("ui/notifications/size-changed", {height: document.documentElement.scrollHeight}); }
function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
function copyText(text, btn){ const ta=document.createElement("textarea"); ta.value=text; document.body.appendChild(ta); ta.select(); try{document.execCommand("copy");}catch(e){} ta.remove(); if(navigator.clipboard) navigator.clipboard.writeText(text).catch(()=>{}); if(btn) btn.textContent="Kopyalandı"; }
function say(text){
  const t = document.getElementById("toast");
  request("ui/message", {role:"user", content:[{type:"text", text}]}).then(r => {
    if(r && r.error){ t.innerHTML = '<div class="toast">Otomatik gönderilemedi. Bu mesajı kopyalayıp sohbete yapıştır: <b>' + esc(text) + '</b> <button id="cpy">Kopyala</button></div>'; document.getElementById("cpy").onclick = e => copyText(text, e.target); reportSize(); }
    else { t.innerHTML = '<div class="toast">Gönderildi: ' + esc(text) + '</div>'; reportSize(); }
  });
}
const LABEL = {image:"görsel", video:"video", audio:"ses", "3d":"3D", file:"dosya"};

function mediaTag(url, cls, attrs){ return /\\.(mp4|webm|mov|m4v)(\\?|$)/i.test(url) ? '<video src="'+esc(url)+'" muted playsinline preload="metadata" class="'+(cls||"")+'" '+(attrs||"")+'></video>' : '<img src="'+esc(url)+'" class="'+(cls||"")+'" '+(attrs||"")+'>'; }

function renderMedia(data){
  if(data.status === "pending") return '<div class="wait">Hazırlanıyor… ('+esc(data.request_id)+')<br>Bitince yeni bir kartta görünecek.</div>';
  const media = data.media || [];
  const short = esc((data.model||"").split("/").slice(-2).join("/"));
  const visual = media.filter(m => m.type==="image"||m.type==="video").length;
  const per = data.cost_usd != null && visual > 1 ? data.cost_usd / visual : null;
  let h = '';
  if(media.length) h += '<div class="grid">' + media.map((m,i) => {
    const u = esc(m.url), d = esc(m.download_url || m.url);
    let v = m.type==="video" ? '<video src="'+u+'" controls playsinline preload="metadata" onloadedmetadata="reportSize()"></video>'
      : m.type==="image" ? '<img src="'+u+'" onload="reportSize()" data-open="'+u+'" style="cursor:zoom-in">'
      : m.type==="audio" ? '<audio src="'+u+'" controls preload="metadata"></audio>' : '<div class="wait">'+esc(m.name||LABEL[m.type])+'</div>';
    return '<div class="card'+(m.type==="audio"?" wide":"")+'">'+v+'<div class="meta"><span class="model">'+short+' <span class="tag">'+(LABEL[m.type]||"dosya")+'</span></span><span class="cost">'+(per!=null?"≈ $"+per.toFixed(3):"")+'</span></div>'+
      '<div class="meta"><button data-open="'+d+'">⬇ İndir</button><button data-open="'+u+'">Aç</button><button data-copy="'+u+'">Linki kopyala</button></div></div>';
  }).join("") + '</div>';
  if(data.subtitle){
    h += '<div class="card wide" style="margin-top:12px"><div class="model">Altyazı · '+esc(data.subtitle.segments)+' satır'+(data.subtitle.saved_to_project?' · projeye kaydedildi':'')+'</div><textarea readonly>'+esc(data.subtitle.srt)+'</textarea>'+
      '<div class="meta"><button data-open="'+esc(data.subtitle.srt_url)+'">⬇ SRT</button><button data-open="'+esc(data.subtitle.vtt_url)+'">⬇ VTT</button></div></div>';
  } else if(data.text){
    h += '<div class="card wide" style="margin-top:12px"><div class="model">Metin</div><textarea readonly>'+esc(data.text)+'</textarea></div>';
  }
  if(!media.length && !data.subtitle && !data.text && data.raw) h += '<div class="card wide"><textarea readonly>'+esc(data.raw)+'</textarea></div>';
  if(data.attach && data.attach.project_id) h += '<div class="foot">Projeye eklendi: '+esc(data.attach.project_id)+(data.attach.scene?' · sahne '+esc(data.attach.scene):'')+' · '+esc(data.attach.kind)+'</div>';
  h += '<div class="foot">'+short+' · Toplam '+(data.cost_usd!=null?"≈ $"+data.cost_usd.toFixed(3):"hesaplanamadı")+(data.price_unit?' · birim: '+esc(data.price_unit):'')+' · arayüz v${VERSION}</div>';
  return h;
}

function renderChoice(c){
  let h = '<div class="card wide"><h3>'+esc(c.title)+'</h3>'+(c.subtitle?'<div class="muted">'+esc(c.subtitle)+'</div>':'')+'</div><div class="grid" style="margin-top:12px">';
  h += c.options.map((o,i) => '<div class="card opt" data-i="'+i+'">'+
    (o.preview_url ? mediaTag(o.preview_url,"",'style="margin-bottom:8px"') : '')+
    '<div class="model">'+esc(o.name)+' '+(o.recommended?'<span class="tag acc">önerilen</span>':'')+'</div>'+
    (o.endpoint_id?'<div class="muted">'+esc(o.endpoint_id)+'</div>':'')+
    (o.price?'<div class="cost" style="margin-top:6px">'+esc(o.price)+'</div>':'')+
    (o.note?'<div class="muted" style="margin-top:4px">'+esc(o.note)+'</div>':'')+
    '<div class="meta"><button class="pick" data-i="'+i+'">Seç</button></div></div>').join("");
  h += '</div><div class="meta" style="margin-top:12px"><span class="muted" id="picked">Bir seçenek seç, sonra İleri\\'ye bas.</span><span><button id="other">Başka seçenek öner</button> <button class="primary" id="next" disabled>İleri ▶</button></span></div>';
  return h;
}

function renderProject(p){
  const cur = p.stages.findIndex(s => s[0] === p.stage);
  let h = '<div class="card wide"><div class="meta" style="margin-top:0"><div><h3>'+esc(p.name)+'</h3><div class="muted">'+esc(p.app||"")+' · '+esc(p.format)+' · hedef '+esc(p.target_duration||"?")+' sn · plan '+esc(p.total_duration)+' sn · harcanan ≈ $'+esc(p.spent_usd)+'</div></div><span class="tag">'+esc(p.id)+'</span></div>';
  h += '<div class="steps">'+p.stages.map((s,i) => '<span class="step '+(i<cur?"done":i===cur?"cur":"")+'">'+esc(s[1])+'</span>').join("")+'</div>';
  if(p.concept) h += '<div class="muted">'+esc(p.concept)+'</div>';
  const m = p.models || {}; const ms = Object.keys(m).filter(k => m[k]);
  if(ms.length) h += '<div class="muted" style="margin-top:4px">Modeller: '+ms.map(k => esc(k)+': '+esc(String(m[k]).split("/").slice(-2).join("/"))).join(" · ")+'</div>';
  if(!p.persistent) h += '<div class="toast">Uyarı: Railway Volume bağlı değil; sunucu yeniden başlarsa proje silinir.</div>';
  h += '</div>';
  h += '<div style="display:flex;flex-direction:column;gap:10px;margin-top:12px">';
  for(const s of p.scenes){
    const chosen = (s.video.chosen && s.video.chosen.url) || (s.image.chosen && s.image.chosen.url);
    const cands = [...s.image.candidates.map(c => ({...c,k:"image"})), ...s.video.candidates.map(c => ({...c,k:"video"}))];
    h += '<div class="card scene"><div class="thumb">'+(chosen ? (s.video.chosen ? '<video src="'+esc(s.video.chosen.url)+'" muted loop playsinline autoplay></video>' : '<img src="'+esc(chosen)+'">') : 'görsel yok')+'</div><div>';
    h += '<div class="meta" style="margin-top:0"><span class="model">'+s.n+'. '+esc(s.title||"Sahne")+' <span class="muted">'+esc(s.duration||"?")+' sn</span></span><span>'+
      '<span class="tag '+(s.image.chosen?"ok":"")+'">görsel '+(s.image.chosen?"✓":s.image.candidates.length)+'</span> '+
      '<span class="tag '+(s.video.chosen?"ok":"")+'">video '+(s.video.chosen?"✓":s.video.candidates.length)+'</span></span></div>';
    if(s.description) h += '<div class="muted">'+esc(s.description)+'</div>';
    if(s.voiceover) h += '<div style="margin-top:4px">🎙 '+esc(s.voiceover)+'</div>';
    if(s.onscreen_text) h += '<div class="muted">Ekran yazısı: '+esc(s.onscreen_text)+'</div>';
    if(cands.length) h += '<div class="cands">'+cands.slice(-8).map(c => {
      const isSel = (s.image.chosen && s.image.chosen.url===c.url) || (s.video.chosen && s.video.chosen.url===c.url);
      return mediaTag(c.url, isSel?"sel":"", 'data-approve="'+s.n+'|'+c.k+'|'+esc(c.url)+'" title="Onayla"');
    }).join("")+'</div>';
    h += '<div class="meta"><input placeholder="Bu sahnede ne değişsin?" data-edit-in="'+s.n+'"><button data-edit="'+s.n+'">Gönder</button></div></div></div>';
  }
  h += '</div>';
  const vo = p.audio.voiceover, mu = p.audio.music;
  if(vo.candidates.length || mu.candidates.length){
    h += '<div class="card wide" style="margin-top:12px"><div class="model">Ses</div>';
    for(const [k,a,l] of [["voiceover",vo,"Dış ses"],["music",mu,"Müzik"]]){
      if(!a.candidates.length) continue;
      h += '<div class="muted" style="margin-top:6px">'+l+(a.chosen?' ✓':'')+'</div>' + a.candidates.slice(-3).map(c => '<div class="meta"><audio src="'+esc(c.url)+'" controls preload="none" style="flex:1"></audio>'+(a.chosen && a.chosen.url===c.url ? '<span class="tag ok">seçili</span>' : '<button data-approve="0|'+k+'|'+esc(c.url)+'">Seç</button>')+'</div>').join("");
    }
    h += '</div>';
  }
  if(p.renders.length){
    const r = p.renders[p.renders.length-1];
    h += '<div class="card wide" style="margin-top:12px"><div class="model">Son birleştirme · '+esc(r.duration)+' sn'+(r.subtitles?' · altyazılı':'')+'</div><video src="'+esc(r.url)+'" controls playsinline preload="metadata" style="max-height:520px;width:auto;max-width:100%;margin:8px auto 0" onloadedmetadata="reportSize()"></video>'+
      '<div class="meta"><button data-open="'+esc(r.download_url)+'">⬇ Videoyu indir</button><button data-open="'+esc(r.url)+'">Aç</button></div></div>';
  }
  h += '<div class="card wide" style="margin-top:12px"><div class="meta" style="margin-top:0"><input placeholder="Genel not / değişiklik isteği" id="gen"><button id="gensend">Gönder</button><button class="primary" id="next">Onayla, İleri ▶</button></div></div>';
  h += '<div class="foot">arayüz v${VERSION}</div>';
  return h;
}

let current = null;
function render(data){
  current = data;
  const el = document.getElementById("app");
  if(!data){ el.innerHTML = '<div class="wait">Sonuç bulunamadı</div>'; return reportSize(); }
  if(data.view === "project") el.innerHTML = renderProject(data.project);
  else if(data.view === "choice") el.innerHTML = renderChoice(data.choice);
  else el.innerHTML = renderMedia(data);
  wire(); reportSize();
  el.querySelectorAll("img,video").forEach(x => { x.addEventListener("load", reportSize); x.addEventListener("loadedmetadata", reportSize); });
}
function wire(){
  const el = document.getElementById("app");
  el.querySelectorAll("[data-open]").forEach(b => b.onclick = () => openLink(b.dataset.open));
  el.querySelectorAll("[data-copy]").forEach(b => b.onclick = () => copyText(b.dataset.copy, b));
  if(current.view === "choice"){
    let sel = null; const c = current.choice;
    el.querySelectorAll(".pick").forEach(b => b.onclick = () => {
      sel = c.options[+b.dataset.i];
      el.querySelectorAll(".opt").forEach(o => o.classList.toggle("sel", o.dataset.i === b.dataset.i));
      document.getElementById("picked").textContent = "Seçilen: " + sel.name;
      document.getElementById("next").disabled = false;
    });
    document.getElementById("next").onclick = () => { if(!sel) return; say("Seçimim (" + c.step + "): " + sel.name + (sel.endpoint_id ? " [" + sel.endpoint_id + "]" : "") + ". Onaylıyorum, ileri."); document.getElementById("next").disabled = true; };
    document.getElementById("other").onclick = () => say("Bu adım (" + c.step + ") için başka seçenekler öner.");
  }
  if(current.view === "project"){
    const p = current.project;
    el.querySelectorAll("[data-approve]").forEach(x => x.onclick = () => {
      const [n,k,u] = x.dataset.approve.split("|");
      say(n !== "0" ? ("Sahne " + n + " için bu " + (k==="video"?"videoyu":"görseli") + " onaylıyorum: " + u) : ((k==="music"?"Bu müziği":"Bu dış sesi") + " seçiyorum: " + u));
    });
    el.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => {
      const inp = el.querySelector('[data-edit-in="'+b.dataset.edit+'"]'); const v = inp.value.trim(); if(!v) { inp.focus(); return; }
      say("Proje " + p.id + ", sahne " + b.dataset.edit + " düzenleme: " + v); inp.value = "";
    });
    document.getElementById("gensend").onclick = () => { const i = document.getElementById("gen"); const v = i.value.trim(); if(!v) return i.focus(); say("Proje " + p.id + " notu: " + v); i.value=""; };
    document.getElementById("next").onclick = () => say("Proje " + p.id + ": bu adımı (" + (p.stages.find(s => s[0]===p.stage)||[,p.stage])[1] + ") onaylıyorum, sonraki adıma geç.");
  }
}

window.addEventListener("message", (ev) => {
  const m = ev.data; if(!m || m.jsonrpc !== "2.0") return;
  if(m.id != null && pending[m.id]){ pending[m.id](m.error ? {error:m.error} : (m.result || {})); delete pending[m.id]; return; }
  if(m.method === "ui/notifications/tool-result"){
    const p = m.params || {};
    let data = p.structuredContent;
    if(!data && Array.isArray(p.content)){ const t = p.content.find(c => c.type === "text"); try { data = JSON.parse(t.text); } catch(e) {} }
    render(data);
  }
});
request("ui/initialize", { appInfo: {name: "fal-studio", version: "${VERSION}.0.0"}, appCapabilities: {}, protocolVersion: "2025-06-18" })
  .then(() => notify("ui/notifications/initialized", {}));
</script></body></html>`;

// ---------- Yükleme sayfası ----------
const UPLOAD_HTML = (secret) => `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>fal stüdyo · yükle</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#222;background:#fafafa}
#drop{border:2px dashed #aaa;border-radius:14px;padding:48px;text-align:center;background:#fff;cursor:pointer}#drop.on{border-color:#6d5bd0;background:#f3f1ff}
.row{display:flex;gap:8px;align-items:center;margin-top:12px;background:#fff;padding:10px;border-radius:10px;border:1px solid #ddd}
.row img,.row video{width:64px;height:64px;object-fit:cover;border-radius:6px}.row input{flex:1;font:13px monospace;padding:6px}button{padding:6px 12px;border-radius:8px;border:1px solid #ccc;background:#fff;cursor:pointer}
.muted{color:#777;font-size:13px}</style></head><body>
<h2>Dosya yükle</h2><p class="muted">Görsel, video veya ses dosyalarını sürükle ya da tıkla. Çıkan linki kopyalayıp Claude'a yapıştır.</p>
<div id="drop">Dosyaları buraya bırak<br><span class="muted">ya da tıkla (en fazla 300 MB)</span><input type="file" id="f" multiple hidden></div><div id="list"></div>
<script>
const drop=document.getElementById("drop"),f=document.getElementById("f"),list=document.getElementById("list");
drop.onclick=()=>f.click();f.onchange=()=>up([...f.files]);
drop.ondragover=e=>{e.preventDefault();drop.classList.add("on")};drop.ondragleave=()=>drop.classList.remove("on");
drop.ondrop=e=>{e.preventDefault();drop.classList.remove("on");up([...e.dataTransfer.files])};
async function up(files){for(const file of files){const row=document.createElement("div");row.className="row";row.textContent="Yükleniyor: "+file.name;list.prepend(row);
try{const r=await fetch("/${secret}/upload?name="+encodeURIComponent(file.name),{method:"PUT",headers:{"Content-Type":file.type||"application/octet-stream"},body:file});const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);
const isV=/^video/.test(file.type),isA=/^audio/.test(file.type);row.innerHTML=(isA?"🎵":isV?'<video src="'+j.url+'" muted></video>':'<img src="'+j.url+'">')+'<input readonly value="'+j.url+'"><button>Kopyala</button>';
const inp=row.querySelector("input"),b=row.querySelector("button");b.onclick=()=>{inp.select();navigator.clipboard.writeText(inp.value);b.textContent="Kopyalandı"};}
catch(e){row.textContent="Hata: "+file.name+" — "+e.message}}}
</script></body></html>`;

// ---------- Model keşfi ----------
async function searchModels({ q, category, limit }) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (category) params.set("category", category);
  params.set("status", "active");
  params.set("limit", String(limit || 20));
  const r = await fetch(`https://api.fal.ai/v1/models?${params}`, { headers: AUTH });
  if (!r.ok) throw new Error(`Model arama hatası ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const models = (j.models || []).map((m) => ({
    endpoint_id: m.endpoint_id,
    name: m.metadata?.display_name,
    category: m.metadata?.category,
    description: (m.metadata?.description || "").slice(0, 220),
    updated_at: m.metadata?.updated_at || m.metadata?.date || null,
  }));
  const prices = await fetchPrices(models.map((m) => m.endpoint_id));
  for (const m of models) {
    const p = prices[m.endpoint_id];
    m.price = p ? `${p.price} USD / ${p.raw_unit || p.unit}` : null;
  }
  return models;
}
async function getSchema(endpointId) {
  let spec = null;
  try {
    const r = await fetch(`https://api.fal.ai/v1/models?endpoint_id=${encodeURIComponent(endpointId)}&expand=openapi-3.0`, { headers: AUTH });
    if (r.ok) spec = (await r.json()).models?.[0]?.openapi || null;
  } catch {}
  if (!spec) {
    const r = await fetch(`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${encodeURIComponent(endpointId)}`);
    if (!r.ok) throw new Error(`Şema alınamadı (${r.status})`);
    spec = await r.json();
  }
  const schemas = spec.components?.schemas || {};
  const inputName = Object.keys(schemas).find((k) => /input$/i.test(k)) || Object.keys(schemas)[0];
  const input = schemas[inputName] || {};
  const props = {};
  for (const [k, v] of Object.entries(input.properties || {})) {
    const e = v.enum || v.anyOf?.find((a) => a.enum)?.enum;
    props[k] = {
      type: v.type || v.anyOf?.map((a) => a.type || (a.$ref ? "object" : "")).filter(Boolean).join("|") || (v.$ref ? "object" : ""),
      ...(e ? { enum: e } : {}),
      ...(v.default !== undefined ? { default: v.default } : {}),
      ...(v.description ? { description: String(v.description).slice(0, 180) } : {}),
    };
  }
  const price = await getPrice(endpointId);
  return { endpoint_id: endpointId, required: input.required || [], properties: props, price: price ? `${price.price} USD / ${price.raw_unit || price.unit}` : null };
}

// ---------- MCP sunucusu ----------
const attachSchema = {
  project_id: z.string().optional().describe("Sonucu bu projeye aday olarak ekle"),
  scene: z.number().int().min(1).optional().describe("Görsel/video için sahne numarası (1'den başlar)"),
};

function buildServer(baseUrl) {
  const server = new McpServer({ name: "fal-ai", version: `${VERSION}.0.0` });
  const uiMeta = { ui: { resourceUri: UI_URI }, "ui/resourceUri": UI_URI };
  const tryRun = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      return errResult(e);
    }
  };
  const att = (project_id, scene, kind) => (project_id ? { project_id, scene: scene || null, kind } : null);

  server.registerResource("fal-studio", UI_URI, { mimeType: UI_MIME, description: "fal stüdyo arayüzü" }, async () => ({
    contents: [
      {
        uri: UI_URI,
        mimeType: UI_MIME,
        text: APP_HTML,
        _meta: {
          ui: {
            csp: {
              resourceDomains: ["https://*.fal.media", "https://fal.media", "https://storage.googleapis.com", baseUrl],
              connectDomains: ["https://*.fal.media", "https://fal.media", "https://storage.googleapis.com", baseUrl],
            },
            prefersBorder: false,
          },
        },
      },
    ],
  }));

  // ===== Keşif =====
  server.registerTool("list_models", { title: "Kısayollar", description: "Hazır model kısayollarını listeler.", inputSchema: {} }, async () => ({
    content: [{ type: "text", text: JSON.stringify(MODELS, null, 2) }],
  }));
  server.registerTool(
    "search_models",
    {
      title: "fal modellerinde ara",
      description:
        "fal.ai kataloğunda canlı arama, fiyatlarıyla. category: text-to-image, image-to-image, image-to-video, text-to-video, video-to-video, text-to-speech, text-to-audio, speech-to-text, audio-to-audio, image-to-3d.",
      inputSchema: { q: z.string().optional(), category: z.string().optional(), limit: z.number().int().min(1).max(50).default(20) },
    },
    async (a) => tryRun(async () => ({ content: [{ type: "text", text: JSON.stringify(await searchModels(a), null, 2) }] }))
  );
  server.registerTool(
    "get_model_schema",
    { title: "Model parametreleri", description: "Bir fal modelinin parametreleri ve fiyatı. Bir modeli ilk kez kullanmadan önce çağır.", inputSchema: { endpoint_id: z.string() } },
    async ({ endpoint_id }) => tryRun(async () => ({ content: [{ type: "text", text: JSON.stringify(await getSchema(resolveModel(endpoint_id)), null, 2) }] }))
  );

  // ===== Seçim kartı =====
  server.registerTool(
    "present_choices",
    {
      title: "Seçenekleri göster",
      description:
        "Kullanıcıya tıklanabilir seçenek kartları + 'İleri' butonu gösterir (model seçimi, konsept/yön seçimi vb.). Kullanıcının seçimi sohbete mesaj olarak gelir. Seçenek sunmadan önce search_models ile güncel model ve fiyatları al.",
      inputSchema: {
        step: z.string().describe("Adım adı, örn. 'görsel modeli', 'video modeli', 'seslendirme', 'konsept'"),
        title: z.string(),
        subtitle: z.string().optional(),
        options: z
          .array(
            z.object({
              name: z.string(),
              endpoint_id: z.string().optional(),
              price: z.string().optional().describe("Örn. '$0.08 / görsel', '≈ $0.30 / 5 sn'"),
              note: z.string().optional().describe("Kısa artı/eksi"),
              recommended: z.boolean().optional(),
              preview_url: z.string().optional(),
            })
          )
          .min(1)
          .max(8),
      },
      _meta: uiMeta,
    },
    async (a) => {
      const s = { view: "choice", choice: a };
      return { content: [{ type: "text", text: `Seçenekler gösterildi (${a.step}). Kullanıcının seçimini bekle.` }], structuredContent: s };
    }
  );

  // ===== Proje =====
  server.registerTool(
    "project_create",
    {
      title: "Reklam projesi oluştur",
      description: "Yeni reklam videosu projesi oluşturur ve panoyu gösterir.",
      inputSchema: {
        name: z.string(),
        app: z.string().optional().describe("Uygulama adı / kısa tanım"),
        concept: z.string().optional(),
        format: z.enum(["9:16", "16:9", "1:1", "4:5"]).default("9:16"),
        target_duration: z.number().optional().describe("Saniye"),
        wants_music: z.boolean().default(true),
      },
      _meta: uiMeta,
    },
    async (a) =>
      tryRun(async () => {
        const id = `${safeName(a.name).toLowerCase().slice(0, 20)}-${rid(2)}`;
        const p = {
          id,
          name: a.name,
          app: a.app || "",
          concept: a.concept || "",
          format: a.format,
          target_duration: a.target_duration || null,
          wants_music: a.wants_music,
          models: { image: null, video: null, tts: null, music: null },
          scenes: [],
          storyboard_approved: false,
          audio: { voiceover: newAsset(), music: newAsset() },
          subtitle: null,
          renders: [],
          spent_usd: 0,
          created_at: new Date().toISOString(),
        };
        await saveProject(p);
        return projectResult(p, baseUrl, "Proje oluşturuldu");
      })
  );
  server.registerTool(
    "project_list",
    { title: "Projeleri listele", description: "Kayıtlı reklam projelerini listeler.", inputSchema: {} },
    async () =>
      tryRun(async () => {
        const fsn = (await fsp.readdir(DIRS.projects)).filter((f) => f.endsWith(".json"));
        const list = [];
        for (const f of fsn) {
          try {
            const p = JSON.parse(await fsp.readFile(path.join(DIRS.projects, f), "utf8"));
            list.push({ id: p.id, name: p.name, app: p.app, stage: computeStage(p), scenes: p.scenes.length, updated_at: p.updated_at });
          } catch {}
        }
        list.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
        return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
      })
  );
  server.registerTool(
    "project_show",
    { title: "Proje panosu", description: "Projenin panosunu gösterir (sahneler, adaylar, onaylar, son render, İleri butonu).", inputSchema: { project_id: z.string() }, _meta: uiMeta },
    async ({ project_id }) => tryRun(async () => projectResult(await loadProject(project_id), baseUrl))
  );
  server.registerTool(
    "project_update",
    {
      title: "Proje bilgilerini güncelle",
      description: "Brief alanlarını, seçilen modelleri, storyboard onayını ve altyazı stilini günceller.",
      inputSchema: {
        project_id: z.string(),
        name: z.string().optional(),
        app: z.string().optional(),
        concept: z.string().optional(),
        format: z.enum(["9:16", "16:9", "1:1", "4:5"]).optional(),
        target_duration: z.number().optional(),
        wants_music: z.boolean().optional(),
        models: z.object({ image: z.string().optional(), video: z.string().optional(), tts: z.string().optional(), music: z.string().optional() }).partial().optional(),
        storyboard_approved: z.boolean().optional(),
        subtitle_enabled: z.boolean().optional(),
        subtitle_style: z
          .object({
            position: z.enum(["bottom", "center", "top"]).optional(),
            size: z.number().optional().describe("Yüksekliğe oran, örn. 0.045"),
            color: z.string().optional(),
            outline_color: z.string().optional(),
            uppercase: z.boolean().optional(),
            margin: z.number().optional(),
          })
          .optional(),
      },
      _meta: uiMeta,
    },
    async (a) =>
      tryRun(async () => {
        const p = await loadProject(a.project_id);
        for (const k of ["name", "app", "concept", "format", "target_duration", "wants_music", "storyboard_approved"]) if (a[k] !== undefined) p[k] = a[k];
        if (a.models) for (const [k, v] of Object.entries(a.models)) if (v) p.models[k] = resolveModel(v);
        if (a.subtitle_enabled !== undefined || a.subtitle_style) {
          p.subtitle = p.subtitle || { cues: [], enabled: true, style: {} };
          if (a.subtitle_enabled !== undefined) p.subtitle.enabled = a.subtitle_enabled;
          if (a.subtitle_style) p.subtitle.style = { ...(p.subtitle.style || {}), ...a.subtitle_style };
        }
        await saveProject(p);
        return projectResult(p, baseUrl, "Güncellendi");
      })
  );
  const sceneFields = {
    title: z.string().optional(),
    duration: z.number().optional().describe("Saniye"),
    description: z.string().optional(),
    voiceover: z.string().optional(),
    onscreen_text: z.string().optional(),
    image_prompt: z.string().optional(),
    video_prompt: z.string().optional(),
  };
  server.registerTool(
    "set_storyboard",
    {
      title: "Storyboard yaz",
      description: "Projenin sahne listesini yazar/değiştirir. keep_assets=true ise aynı sıradaki sahnelerin görsel/videoları korunur. Storyboard onayı için project_update storyboard_approved=true.",
      inputSchema: { project_id: z.string(), scenes: z.array(z.object(sceneFields)).min(1).max(20), keep_assets: z.boolean().default(true) },
      _meta: uiMeta,
    },
    async ({ project_id, scenes, keep_assets }) =>
      tryRun(async () => {
        const p = await loadProject(project_id);
        const old = p.scenes;
        p.scenes = scenes.map((f, i) => {
          const s = newScene(f);
          if (keep_assets && old[i]) {
            s.id = old[i].id;
            s.image = old[i].image;
            s.video = old[i].video;
          }
          return s;
        });
        p.storyboard_approved = false;
        await saveProject(p);
        return projectResult(p, baseUrl, "Storyboard yazıldı, onay bekliyor");
      })
  );
  server.registerTool(
    "edit_scene",
    {
      title: "Sahne düzenle",
      description:
        "Tek sahneyi düzenler: update (alanları değiştir), insert (bu konuma yeni sahne), delete, move (to konumuna taşı). clear='image'|'video'|'both' seçilenleri sıfırlar (sahneyi yeniden üretmek için).",
      inputSchema: {
        project_id: z.string(),
        action: z.enum(["update", "insert", "delete", "move"]),
        scene: z.number().int().min(1),
        to: z.number().int().min(1).optional(),
        fields: z.object(sceneFields).optional(),
        clear: z.enum(["none", "image", "video", "both"]).default("none"),
      },
      _meta: uiMeta,
    },
    async ({ project_id, action, scene, to, fields, clear }) =>
      tryRun(async () => {
        const p = await loadProject(project_id);
        const i = scene - 1;
        if (action === "insert") p.scenes.splice(Math.min(i, p.scenes.length), 0, newScene(fields || {}));
        else {
          const s = p.scenes[i];
          if (!s) throw new Error(`Sahne ${scene} yok`);
          if (action === "delete") p.scenes.splice(i, 1);
          else if (action === "move") {
            if (!to) throw new Error("to gerekli");
            p.scenes.splice(i, 1);
            p.scenes.splice(to - 1, 0, s);
          } else {
            Object.assign(s, Object.fromEntries(Object.entries(fields || {}).filter(([, v]) => v !== undefined)));
            if (clear === "image" || clear === "both") s.image.chosen = null;
            if (clear === "video" || clear === "both") s.video.chosen = null;
          }
        }
        await saveProject(p);
        return projectResult(p, baseUrl, `Sahne ${scene}: ${action}`);
      })
  );
  server.registerTool(
    "approve_asset",
    {
      title: "Onayla / seç",
      description:
        "Bir sahnenin görselini/videosunu ya da projenin dış sesini/müziğini seçer. url aday listesinde yoksa eklenir (kullanıcının yüklediği dosyalar için de kullan). url boş verilirse seçim kaldırılır.",
      inputSchema: {
        project_id: z.string(),
        kind: z.enum(["image", "video", "voiceover", "music"]),
        scene: z.number().int().min(1).optional(),
        url: z.string().optional(),
        duration: z.number().optional().describe("Dış ses süresi (biliniyorsa)"),
      },
      _meta: uiMeta,
    },
    async ({ project_id, kind, scene, url, duration }) =>
      tryRun(async () => {
        const p = await loadProject(project_id);
        let slot;
        if (kind === "image" || kind === "video") {
          const s = p.scenes[(scene || 0) - 1];
          if (!s) throw new Error("Geçerli sahne numarası gerekli");
          slot = s[kind];
        } else slot = p.audio[kind];
        if (!url) slot.chosen = null;
        else {
          let c = slot.candidates.find((x) => x.url === url);
          if (!c) {
            c = { url, model: "yükleme", at: new Date().toISOString() };
            slot.candidates.push(c);
          }
          if (duration) c.duration = duration;
          slot.chosen = c;
        }
        await saveProject(p);
        return projectResult(p, baseUrl, url ? `${kind} seçildi` : `${kind} seçimi kaldırıldı`);
      })
  );

  // ===== Üretim =====
  server.registerTool(
    "run_model",
    {
      title: "Herhangi bir fal modeli",
      description:
        "fal'daki HERHANGİ bir modeli çalıştırır (upscale, arka plan silme, lipsync, video-to-video, 3D, ses efekti...). Önce get_model_schema. attach_as ile sonucu projeye ekle.",
      inputSchema: {
        endpoint_id: z.string(),
        input: z.record(z.any()),
        wait_seconds: z.number().int().min(5).max(110).default(100),
        attach_as: z.enum(["image", "video", "voiceover", "music"]).optional(),
        ...attachSchema,
      },
      _meta: uiMeta,
    },
    async ({ endpoint_id, input, wait_seconds, attach_as, project_id, scene }) =>
      tryRun(() => {
        const modelId = resolveModel(endpoint_id);
        const text = input.text || input.prompt || "";
        const ctx = { chars: typeof text === "string" ? text.length : null, durationSec: parseFloat(input.duration) || null, attach: attach_as ? att(project_id, scene, attach_as) : null };
        return runAndRender({ modelId, input, prompt: typeof text === "string" ? text : "", baseUrl, ctx, waitMs: wait_seconds * 1000 });
      })
  );
  server.registerTool(
    "generate_image",
    {
      title: "Görsel üret",
      description: "Metinden görsel üretir. project_id+scene verilirse sahneye aday olarak eklenir.",
      inputSchema: {
        prompt: z.string(),
        model: z.string().default("nano-banana-2"),
        image_size: z.string().optional(),
        aspect_ratio: z.string().optional(),
        num_images: z.number().int().min(1).max(4).default(1),
        seed: z.number().int().optional(),
        extra: z.record(z.any()).optional(),
        ...attachSchema,
      },
      _meta: uiMeta,
    },
    async ({ prompt, model, image_size, aspect_ratio, num_images, seed, extra, project_id, scene }) =>
      tryRun(() => {
        const input = { prompt, num_images, ...(extra || {}) };
        if (image_size) input.image_size = image_size;
        if (aspect_ratio) input.aspect_ratio = aspect_ratio;
        if (seed !== undefined) input.seed = seed;
        return runAndRender({ modelId: resolveModel(model), input, prompt, baseUrl, ctx: { attach: att(project_id, scene, "image") }, waitMs: 110000 });
      })
  );
  server.registerTool(
    "edit_image",
    {
      title: "Görsel düzenle",
      description: "Referans görsel(ler)le düzenleme/üretim (karakter tutarlılığı, ürün yerleştirme). project_id+scene verilirse sahneye eklenir.",
      inputSchema: {
        prompt: z.string(),
        image_urls: z.array(z.string().url()).min(1),
        model: z.string().default("nano-banana-edit"),
        num_images: z.number().int().min(1).max(4).default(1),
        extra: z.record(z.any()).optional(),
        ...attachSchema,
      },
      _meta: uiMeta,
    },
    async ({ prompt, image_urls, model, num_images, extra, project_id, scene }) =>
      tryRun(() =>
        runAndRender({ modelId: resolveModel(model), input: { prompt, image_urls, num_images, ...(extra || {}) }, prompt, baseUrl, ctx: { attach: att(project_id, scene, "image") }, waitMs: 110000 })
      )
  );
  server.registerTool(
    "generate_video",
    {
      title: "Video üret",
      description: "Text/image-to-video. Önce get_model_schema ile parametre adlarını kontrol et. project_id+scene verilirse sahneye eklenir. Bitmezse pending → check_job.",
      inputSchema: {
        prompt: z.string(),
        model: z.string(),
        image_url: z.string().url().optional(),
        end_image_url: z.string().url().optional(),
        duration: z.union([z.string(), z.number()]).optional(),
        resolution: z.string().optional(),
        aspect_ratio: z.string().optional(),
        generate_audio: z.boolean().optional(),
        extra: z.record(z.any()).optional(),
        ...attachSchema,
      },
      _meta: uiMeta,
    },
    async ({ prompt, model, image_url, end_image_url, duration, resolution, aspect_ratio, generate_audio, extra, project_id, scene }) =>
      tryRun(() => {
        const modelId = resolveModel(model);
        const input = { prompt };
        if (image_url) input[/kling/.test(modelId) ? "start_image_url" : "image_url"] = image_url;
        if (end_image_url) input.end_image_url = end_image_url;
        if (duration !== undefined) input.duration = duration;
        if (resolution) input.resolution = resolution;
        if (aspect_ratio) input.aspect_ratio = aspect_ratio;
        if (generate_audio !== undefined) input.generate_audio = generate_audio;
        Object.assign(input, extra || {});
        return runAndRender({ modelId, input, prompt, baseUrl, ctx: { durationSec: parseFloat(input.duration) || null, attach: att(project_id, scene, "video") }, waitMs: 100000 });
      })
  );
  server.registerTool(
    "text_to_speech",
    {
      title: "Seslendirme",
      description: "Metni sese çevirir. Varsayılan MiniMax Speech 2.8 HD. project_id verilirse dış ses adayı olarak eklenir.",
      inputSchema: {
        text: z.string(),
        model: z.string().default("minimax-speech-hd"),
        voice: z.string().optional(),
        language: z.string().optional().describe("MiniMax language_boost, örn. Turkish, English"),
        extra: z.record(z.any()).optional(),
        project_id: z.string().optional(),
      },
      _meta: uiMeta,
    },
    async ({ text, model, voice, language, extra, project_id }) =>
      tryRun(() => {
        const modelId = resolveModel(model);
        const isMinimax = /minimax/.test(modelId);
        const input = isMinimax ? { prompt: text } : { text };
        if (voice) isMinimax ? (input.voice_setting = { voice_id: voice }) : (input.voice = voice);
        if (language && isMinimax) input.language_boost = language;
        Object.assign(input, extra || {});
        return runAndRender({ modelId, input, prompt: text, baseUrl, ctx: { chars: text.length, attach: att(project_id, null, "voiceover") }, waitMs: 110000 });
      })
  );
  server.registerTool(
    "generate_music",
    {
      title: "Müzik üret",
      description: "Söz varsa MiniMax Music, yoksa ElevenLabs Music v2. project_id verilirse müzik adayı olarak eklenir.",
      inputSchema: {
        prompt: z.string(),
        lyrics: z.string().optional(),
        model: z.string().optional(),
        duration_seconds: z.number().optional(),
        extra: z.record(z.any()).optional(),
        project_id: z.string().optional(),
      },
      _meta: uiMeta,
    },
    async ({ prompt, lyrics, model, duration_seconds, extra, project_id }) =>
      tryRun(() => {
        const modelId = resolveModel(model || (lyrics ? "minimax-music" : "elevenlabs-music"));
        const input = { prompt };
        if (lyrics) input[/minimax-music/.test(modelId) ? "lyrics_prompt" : "lyrics"] = lyrics;
        if (duration_seconds) /elevenlabs\/music/.test(modelId) ? (input.music_length_ms = Math.round(duration_seconds * 1000)) : (input.duration = duration_seconds);
        Object.assign(input, extra || {});
        return runAndRender({ modelId, input, prompt, baseUrl, ctx: { durationSec: duration_seconds || null, attach: att(project_id, null, "music") }, waitMs: 110000 });
      })
  );
  server.registerTool(
    "transcribe",
    {
      title: "Altyazı",
      description:
        "Ses/video URL'sinden zaman kodlu altyazı (SRT+VTT). project_id verilirse altyazı projeye kaydedilir ve render'da videoya yakılır. media_url boşsa projenin seçili dış sesi kullanılır. Kelime zamanlı sonuç için elevenlabs-stt önerilir.",
      inputSchema: {
        media_url: z.string().url().optional(),
        model: z.string().default("elevenlabs-stt"),
        language: z.string().optional().describe("elevenlabs: tur, eng...  whisper: tr, en..."),
        max_words_per_line: z.number().int().min(1).max(15).default(4),
        extra: z.record(z.any()).optional(),
        project_id: z.string().optional(),
      },
      _meta: uiMeta,
    },
    async ({ media_url, model, language, max_words_per_line, extra, project_id }) =>
      tryRun(async () => {
        let url = media_url;
        if (!url && project_id) url = (await loadProject(project_id)).audio.voiceover.chosen?.url;
        if (!url) throw new Error("media_url yok ve projede seçili dış ses yok");
        const modelId = resolveModel(model);
        const input = { audio_url: url };
        if (/whisper|wizper/.test(modelId)) input.chunk_level = "word";
        if (language) input[/elevenlabs/.test(modelId) ? "language_code" : "language"] = language;
        Object.assign(input, extra || {});
        return runAndRender({ modelId, input, prompt: "", baseUrl, ctx: { maxWords: max_words_per_line, project_id, media_url: url }, waitMs: 110000, kind: "transcribe" });
      })
  );

  // ===== Birleştirme =====
  server.registerTool(
    "render_video",
    {
      title: "Videoyu birleştir",
      description:
        "Projenin onaylı sahnelerini sırayla birleştirir (sahne süresine kırpar, formatı ayarlar; videosu olmayan sahnede görsele hafif zoom). Dış ses + müzik (konuşmada müzik otomatik kısılır) + altyazı yakma. Uzun sürerse pending döner → check_job.",
      inputSchema: {
        project_id: z.string(),
        subtitles: z.boolean().default(true),
        music_volume: z.number().min(0).max(1.5).default(0.3),
        voiceover_volume: z.number().min(0).max(2).default(1.0),
        voiceover_offset: z.number().min(0).max(10).default(0.3).describe("Dış sesin başlama gecikmesi (sn)"),
        keep_scene_audio: z.boolean().default(false).describe("Sahne videolarının kendi sesini koru"),
        scene_audio_volume: z.number().min(0).max(1.5).default(0.6),
      },
      _meta: uiMeta,
    },
    async (opt) =>
      tryRun(async () => {
        const p = await loadProject(opt.project_id);
        const jobId = `render-${rid(4)}`;
        const job = { status: "running", project_id: p.id };
        job.promise = renderProject(p, baseUrl, opt)
          .then(async (rec) => {
            const fresh = await loadProject(p.id);
            fresh.renders.push(rec);
            await saveProject(fresh);
            job.status = "done";
            job.result = fresh;
          })
          .catch((e) => {
            job.status = "error";
            job.error = e.message;
          });
        renderJobs.set(jobId, job);
        await Promise.race([job.promise, new Promise((r) => setTimeout(r, 100000))]);
        if (job.status === "done") return projectResult(job.result, baseUrl, "Render tamamlandı");
        if (job.status === "error") return errResult(job.error);
        return pendingResult("ffmpeg", jobId, "render");
      })
  );

  // ===== İş sorgulama =====
  server.registerTool(
    "check_job",
    {
      title: "İşi sorgula",
      description: "Devam eden fal işini ya da render işini (render-...) sorgular; bittiyse sonucu gösterir. ~60 sn bekler.",
      inputSchema: { request_id: z.string(), model: z.string().optional(), duration: z.number().optional() },
      _meta: uiMeta,
    },
    async ({ request_id, model, duration }) =>
      tryRun(async () => {
        if (request_id.startsWith("render-")) {
          const job = renderJobs.get(request_id);
          if (!job) return errResult("Render işi bulunamadı (sunucu yeniden başlamış olabilir). render_video'yu tekrar çalıştır.");
          await Promise.race([job.promise, new Promise((r) => setTimeout(r, 60000))]);
          if (job.status === "done") return projectResult(job.result, baseUrl, "Render tamamlandı");
          if (job.status === "error") return errResult(job.error);
          return pendingResult("ffmpeg", request_id, "render");
        }
        let job = jobs.get(request_id);
        if (!job) {
          if (!model) return errResult("Bu iş bilinmiyor; model parametresini de ver.");
          const modelId = resolveModel(model);
          job = { modelId, ...queueUrls(modelId, request_id), prompt: "", ctx: { durationSec: duration || null } };
        }
        const res = await waitFal(job.status_url, job.response_url, 60000);
        if (!res) return pendingResult(job.modelId, request_id, job.prompt);
        jobs.delete(request_id);
        return finalize(res, { modelId: job.modelId, prompt: job.prompt, baseUrl, ctx: job.ctx || {}, kind: job.kind });
      })
  );

  server.registerTool(
    "upload_link",
    { title: "Yükleme sayfası", description: "Kullanıcının kendi görsel/video/ses dosyalarını yükleyebileceği sayfanın linkini verir.", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: `${baseUrl}/${MCP_SECRET}/upload` }] })
  );

  return server;
}

// ---------- HTTP ----------
const app = express();
app.get("/", (_req, res) => res.send(`fal MCP v${VERSION} çalışıyor · depolama: ${PERSISTENT ? "kalıcı (Volume)" : "geçici"} · ffmpeg: ${ffmpegPath ? "var" : "yok"}`));

// Yükleme
app.get(`/${MCP_SECRET}/upload`, (_req, res) => res.type("html").send(UPLOAD_HTML(MCP_SECRET)));
app.put(`/${MCP_SECRET}/upload`, express.raw({ type: () => true, limit: "300mb" }), async (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: "Boş dosya" });
    const name = `up-${rid(6)}-${safeName(req.query.name)}`;
    await fsp.writeFile(path.join(DIRS.media, name), req.body);
    res.json({ url: `https://${req.get("host")}/media/${name}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Medya (yüklemeler + renderlar)
app.use("/media", express.static(DIRS.media, { maxAge: "1h" }));
app.get("/media-dl/:name", (req, res) => {
  const f = path.join(DIRS.media, path.basename(req.params.name));
  if (!fs.existsSync(f)) return res.status(404).send("Bulunamadı");
  res.download(f);
});

// fal dosyalarını indirme proxy'si
app.get("/dl", async (req, res) => {
  try {
    const u = new URL(String(req.query.url || ""));
    const okHost =
      u.protocol === "https:" &&
      (u.hostname === "fal.media" || u.hostname.endsWith(".fal.media") || (u.hostname === "storage.googleapis.com" && u.pathname.startsWith("/falserverless/")));
    if (!okHost) return res.status(400).send("Geçersiz adres");
    const r = await fetch(u.toString());
    if (!r.ok) return res.status(502).send("Dosya alınamadı");
    res.setHeader("Content-Type", r.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName(u.pathname.split("/").pop())}"`);
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(400).send("Geçersiz istek");
  }
});

// SRT/VTT
app.get("/file/:id", (req, res) => {
  const f = files.get(req.params.id);
  if (!f || f.exp < Date.now()) return res.status(404).send("Dosya bulunamadı ya da süresi doldu");
  res.setHeader("Content-Type", `${f.mime}; charset=utf-8`);
  res.setHeader("Content-Disposition", `attachment; filename="${f.name}"`);
  res.send(f.body);
});

// MCP
app.post(`/${MCP_SECRET}/mcp`, express.json({ limit: "10mb" }), async (req, res) => {
  try {
    const server = buildServer(`https://${req.get("host")}`);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});
const notAllowed = (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
app.get(`/${MCP_SECRET}/mcp`, notAllowed);
app.delete(`/${MCP_SECRET}/mcp`, notAllowed);

app.listen(PORT, () => console.log(`fal MCP v${VERSION} :${PORT} · data: ${DATA_DIR}`));

export { toSubtitle, buildAss, renderProject, extractMedia, computeStage, DIRS };
