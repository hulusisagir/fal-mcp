// fal.ai remote MCP server v2 — MCP Apps galeri arayüzü + tahmini maliyet
// Env: FAL_KEY, MCP_SECRET, PORT (opsiyonel)

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const FAL_KEY = process.env.FAL_KEY;
const MCP_SECRET = process.env.MCP_SECRET;
const PORT = process.env.PORT || 3000;

if (!FAL_KEY || !MCP_SECRET) {
  console.error("FAL_KEY ve MCP_SECRET ortam değişkenleri gerekli.");
  process.exit(1);
}

// ---------- Modeller ----------
const MODELS = {
  "flux-dev": "fal-ai/flux/dev",
  "flux-schnell": "fal-ai/flux/schnell",
  "flux-pro-ultra": "fal-ai/flux-pro/v1.1-ultra",
  "nano-banana": "fal-ai/nano-banana",
  "nano-banana-edit": "fal-ai/nano-banana/edit",
  "nano-banana-2": "fal-ai/nano-banana-2",
  "nano-banana-pro": "fal-ai/nano-banana-pro",
  "seedream": "fal-ai/bytedance/seedream/v4/text-to-image",
  "seedream-edit": "fal-ai/bytedance/seedream/v4/edit",
  "recraft": "fal-ai/recraft/v3/text-to-image",
  "gpt-image-2.5": "openai/gpt-image-2.5/flare/text-to-image",
  "gpt-image-2": "openai/gpt-image-2",
};
const resolveModel = (m) => MODELS[m] || m;

// ---------- Fiyat (tahmini) ----------
// Önce fal'ın fiyat API'sini dener, olmazsa bu tabloya düşer. Birim: görsel başına USD ya da megapiksel başına USD.
const PRICE_TABLE = {
  "fal-ai/flux/dev": { unit: "mp", price: 0.025 },
  "fal-ai/flux/schnell": { unit: "mp", price: 0.003 },
  "fal-ai/flux-pro/v1.1-ultra": { unit: "image", price: 0.06 },
  "fal-ai/nano-banana": { unit: "image", price: 0.039 },
  "fal-ai/nano-banana/edit": { unit: "image", price: 0.039 },
  "fal-ai/nano-banana-2": { unit: "image", price: 0.08 },
  "fal-ai/nano-banana-pro": { unit: "image", price: 0.15 },
  "fal-ai/bytedance/seedream/v4/text-to-image": { unit: "image", price: 0.03 },
  "fal-ai/bytedance/seedream/v4/edit": { unit: "image", price: 0.03 },
  "fal-ai/recraft/v3/text-to-image": { unit: "image", price: 0.04 },
  "openai/gpt-image-2.5/flare/text-to-image": { unit: "image", price: 0.19 },
  "openai/gpt-image-2": { unit: "image", price: 0.19 },
};

const priceCache = new Map();
async function getPrice(modelId) {
  if (priceCache.has(modelId)) return priceCache.get(modelId);
  let p = null;
  try {
    const r = await fetch(
      `https://api.fal.ai/v1/models/pricing?endpoint_id=${encodeURIComponent(modelId)}`,
      { headers: { Authorization: `Key ${FAL_KEY}` } }
    );
    if (r.ok) {
      const j = await r.json();
      const item = (j.prices || j.data || [])[0];
      if (item && typeof item.unit_price === "number") {
        const u = String(item.unit || "").toLowerCase();
        p = { unit: u.includes("mega") || u.includes("mp") ? "mp" : "image", price: item.unit_price, source: "fal" };
      }
    }
  } catch {
    /* tabloya düş */
  }
  if (!p && PRICE_TABLE[modelId]) p = { ...PRICE_TABLE[modelId], source: "tablo" };
  priceCache.set(modelId, p);
  return p;
}

function estimateCost(price, images) {
  if (!price) return null;
  if (price.unit === "mp") {
    return images.reduce((sum, im) => {
      const mp = im.width && im.height ? (im.width * im.height) / 1e6 : 1;
      return sum + Math.max(1, Math.ceil(mp)) * price.price;
    }, 0);
  }
  return price.price * images.length;
}

// ---------- fal çağrısı ----------
async function runFal(modelId, input, timeoutMs = 240000) {
  const headers = { Authorization: `Key ${FAL_KEY}`, "Content-Type": "application/json" };
  const submit = await fetch(`https://queue.fal.run/${modelId}`, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  if (!submit.ok) throw new Error(`fal submit hatası ${submit.status}: ${await submit.text()}`);
  const { status_url, response_url } = await submit.json();

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1500));
    const st = await (await fetch(status_url, { headers })).json();
    if (st.status === "COMPLETED") {
      const res = await fetch(response_url, { headers });
      if (!res.ok) throw new Error(`fal sonuç hatası ${res.status}: ${await res.text()}`);
      return res.json();
    }
    if (st.status === "FAILED" || st.error) throw new Error(`fal işi başarısız: ${JSON.stringify(st)}`);
  }
  throw new Error("fal zaman aşımı");
}

async function buildResult(result, modelId, prompt, baseUrl) {
  const raw = result.images || (result.image ? [result.image] : []);
  const images = raw
    .filter((i) => i && i.url)
    .map((i) => ({ url: i.url, width: i.width || null, height: i.height || null, download_url: baseUrl ? `${baseUrl}/dl?url=${encodeURIComponent(i.url)}` : i.url }));
  const price = await getPrice(modelId);
  const cost = estimateCost(price, images);

  const structured = {
    model: modelId,
    prompt,
    images,
    cost_usd: cost !== null ? Math.round(cost * 1000) / 1000 : null,
    cost_source: price ? price.source : null,
  };

  const content = [{ type: "text", text: JSON.stringify(structured, null, 2) }];

  // Claude'un da görebilmesi için küçük önizleme
  for (const im of images.slice(0, 4)) {
    try {
      const r = await fetch(im.url);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 4.5 * 1024 * 1024) continue;
      content.push({ type: "image", data: buf.toString("base64"), mimeType: r.headers.get("content-type") || "image/png" });
    } catch {
      /* URL yeterli */
    }
  }
  return { content, structuredContent: structured };
}

// ---------- Galeri arayüzü (MCP Apps) ----------
const UI_VERSION = "4";
const UI_URI = `ui://fal/gallery-v${UI_VERSION}.html`;
const UI_MIME = "text/html;profile=mcp-app";

const GALLERY_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;--bg:transparent;--card:rgba(127,127,127,.08);--line:rgba(127,127,127,.25);--muted:rgba(127,127,127,1)}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,sans-serif;background:var(--bg);color:CanvasText}
.wrap{padding:8px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.card{border:1px solid var(--line);border-radius:12px;padding:10px;background:var(--card)}
.card img{width:100%;display:block;border-radius:8px;cursor:zoom-in}
.meta{display:flex;justify-content:space-between;align-items:center;margin-top:10px;gap:8px}
.model{font-weight:600;font-size:13px}.size{font-size:12px;color:var(--muted)}
.cost{font-weight:600;font-size:15px}
button{font:inherit;font-size:13px;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer}
button:hover{background:var(--card)}
.foot{margin-top:10px;font-size:12px;color:var(--muted)}
.wait{padding:24px;text-align:center;color:var(--muted)}
</style></head>
<body><div class="wrap" id="app"><div class="wait">Görsel bekleniyor…</div></div>
<script>
let nextId = 1; const pending = {};
function send(msg){ window.parent.postMessage(msg, "*"); }
function request(method, params){ const id = nextId++; send({jsonrpc:"2.0", id, method, params}); return new Promise(r => pending[id] = r); }
function notify(method, params){ send({jsonrpc:"2.0", method, params}); }
function openLink(url){ try{ request("ui/open-link", {url}); }catch(e){} try{ window.open(url, "_blank", "noopener"); }catch(e){} }
function copyUrl(inp, btn){ inp.select(); let ok=false; try{ ok=document.execCommand("copy"); }catch(e){} if(navigator.clipboard){ navigator.clipboard.writeText(inp.value).then(()=>{btn.textContent="Kopyalandı";}).catch(()=>{}); } if(ok) btn.textContent="Kopyalandı"; }
function reportSize(){ notify("ui/notifications/size-changed", {height: document.documentElement.scrollHeight}); }

function render(data){
  const el = document.getElementById("app");
  if(!data || !data.images || !data.images.length){ el.innerHTML = '<div class="wait">Görsel bulunamadı</div>'; return reportSize(); }
  const per = data.cost_usd != null ? data.cost_usd / data.images.length : null;
  const short = (data.model||"").split("/").slice(-2).join("/");
  el.innerHTML = '<div class="grid">' + data.images.map((im,i) => \`
    <div class="card">
      <img src="\${im.url}" alt="Üretilen görsel \${i+1}" onload="reportSize()" data-url="\${im.url}">
      <div class="meta">
        <div><div class="model">\${short}</div><div class="size">\${im.width && im.height ? im.width+"×"+im.height : ""}</div></div>
        <div class="cost">\${per != null ? "≈ $" + per.toFixed(3) : "—"}</div>
      </div>
      <div class="meta"><button data-dl="\${im.download_url || im.url}">⬇ İndir</button><button data-open="\${im.url}">Tam boyut</button></div>
      <div class="meta"><input readonly value="\${im.url}" style="flex:1;min-width:0;font:12px system-ui;padding:6px 8px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit" onclick="this.select()"><button data-copy>Kopyala</button></div>
    </div>\`).join("") + '</div>' +
    '<div class="foot">Toplam ' + (data.cost_usd != null ? "≈ $" + data.cost_usd.toFixed(3) : "bilinmiyor") +
    ' · ' + (data.cost_source === "fal" ? "fal fiyat API" : "tahmini fiyat tablosu") + ' · arayüz v4</div>';
  el.querySelectorAll("[data-open]").forEach(b => b.onclick = () => openLink(b.dataset.open));
  el.querySelectorAll("img").forEach(b => b.onclick = () => openLink(b.dataset.url));
  el.querySelectorAll("[data-dl]").forEach(b => b.onclick = () => openLink(b.dataset.dl));
  el.querySelectorAll("[data-copy]").forEach(b => b.onclick = () => copyUrl(b.previousElementSibling, b));
  reportSize();
}

window.addEventListener("message", (ev) => {
  const m = ev.data; if(!m || m.jsonrpc !== "2.0") return;
  if(m.id != null && pending[m.id]){ pending[m.id](m.result); delete pending[m.id]; return; }
  if(m.method === "ui/notifications/tool-result"){
    const p = m.params || {};
    let data = p.structuredContent;
    if(!data && Array.isArray(p.content)){
      const t = p.content.find(c => c.type === "text");
      try { data = JSON.parse(t.text); } catch(e) {}
    }
    render(data);
  }
});

request("ui/initialize", {
  appInfo: {name: "fal-gallery", version: "1.0.0"},
  appCapabilities: {},
  protocolVersion: "2025-06-18"
}).then(() => notify("ui/notifications/initialized", {}));
</script></body></html>`;

// ---------- MCP sunucusu ----------
function buildServer(baseUrl) {
  const server = new McpServer({ name: "fal-ai", version: "3.0.0" });

  server.registerResource(
    "fal-gallery",
    UI_URI,
    { mimeType: UI_MIME, description: "fal görsel galerisi" },
    async () => ({
      contents: [
        {
          uri: UI_URI,
          mimeType: UI_MIME,
          text: GALLERY_HTML,
          _meta: {
            ui: {
              csp: {
                resourceDomains: ["https://*.fal.media", "https://fal.media", "https://storage.googleapis.com"],
                connectDomains: ["https://*.fal.media", "https://fal.media", "https://storage.googleapis.com"],
              },
              prefersBorder: false,
            },
          },
        },
      ],
    })
  );

  const uiMeta = { ui: { resourceUri: UI_URI }, "ui/resourceUri": UI_URI };

  server.registerTool(
    "list_models",
    {
      title: "Modelleri listele",
      description: "Kullanılabilir model kısayollarını listeler. Tam fal model ID'si de doğrudan kullanılabilir.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: JSON.stringify(MODELS, null, 2) }] })
  );

  server.registerTool(
    "generate_image",
    {
      title: "Görsel üret",
      description:
        "fal.ai ile metinden görsel üretir ve sonucu galeri kartında gösterir (tahmini maliyet + indirme). model: kısayol (flux-dev, nano-banana-2, gpt-image-2.5...) veya tam fal model ID'si.",
      inputSchema: {
        prompt: z.string().describe("Görsel promptu"),
        model: z.string().default("flux-dev"),
        image_size: z
          .string()
          .optional()
          .describe("square_hd, square, portrait_4_3, portrait_16_9, landscape_4_3, landscape_16_9 (Flux ve GPT Image için)"),
        aspect_ratio: z.string().optional().describe("Örn. 9:16, 1:1, 16:9 (Nano Banana / Flux Ultra için)"),
        num_images: z.number().int().min(1).max(4).default(1),
        seed: z.number().int().optional(),
        extra: z.record(z.any()).optional().describe("Modele özel ek parametreler, örn. {quality: 'medium'}"),
      },
      _meta: uiMeta,
    },
    async ({ prompt, model, image_size, aspect_ratio, num_images, seed, extra }) => {
      const modelId = resolveModel(model);
      const input = { prompt, num_images, ...(extra || {}) };
      if (image_size) input.image_size = image_size;
      if (aspect_ratio) input.aspect_ratio = aspect_ratio;
      if (seed !== undefined) input.seed = seed;
      try {
        return await buildResult(await runFal(modelId, input), modelId, prompt, baseUrl);
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: String(e.message || e) }] };
      }
    }
  );

  server.registerTool(
    "edit_image",
    {
      title: "Görsel düzenle",
      description: "Referans görsel(ler) ile düzenleme/üretim yapar (nano-banana-edit, seedream-edit vb.) ve galeri kartında gösterir.",
      inputSchema: {
        prompt: z.string(),
        image_urls: z.array(z.string().url()).min(1).describe("Herkese açık görsel URL'leri"),
        model: z.string().default("nano-banana-edit"),
        num_images: z.number().int().min(1).max(4).default(1),
        extra: z.record(z.any()).optional(),
      },
      _meta: uiMeta,
    },
    async ({ prompt, image_urls, model, num_images, extra }) => {
      const modelId = resolveModel(model);
      const input = { prompt, image_urls, num_images, ...(extra || {}) };
      try {
        return await buildResult(await runFal(modelId, input), modelId, prompt, baseUrl);
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: String(e.message || e) }] };
      }
    }
  );

  return server;
}

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: "10mb" }));
app.get("/", (_req, res) => res.send("fal MCP v4 çalışıyor"));

// İndirme proxy'si: yalnızca fal.media görsellerini "attachment" olarak döndürür
app.get("/dl", async (req, res) => {
  try {
    const u = new URL(String(req.query.url || ""));
    const okHost = u.protocol === "https:" && (u.hostname === "fal.media" || u.hostname.endsWith(".fal.media"));
    if (!okHost) return res.status(400).send("Geçersiz adres");
    const r = await fetch(u.toString());
    if (!r.ok) return res.status(502).send("Görsel alınamadı");
    const name = (u.pathname.split("/").pop() || "fal.png").replace(/[^\w.\-]/g, "_");
    res.setHeader("Content-Type", r.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(400).send("Geçersiz istek");
  }
});

app.post(`/${MCP_SECRET}/mcp`, async (req, res) => {
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
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }
});

const notAllowed = (_req, res) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
app.get(`/${MCP_SECRET}/mcp`, notAllowed);
app.delete(`/${MCP_SECRET}/mcp`, notAllowed);

app.listen(PORT, () => console.log(`fal MCP v4 :${PORT} portunda`));
