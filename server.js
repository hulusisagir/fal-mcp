// fal.ai remote MCP server (Streamable HTTP, stateless)
// Env: FAL_KEY (required), MCP_SECRET (required, URL path token), PORT (optional)

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

// Kısayollar — istediğin modeli buraya ekleyebilirsin. Tam model ID'si de kabul edilir.
const MODELS = {
  "flux-dev": "fal-ai/flux/dev",
  "flux-schnell": "fal-ai/flux/schnell",
  "flux-pro-ultra": "fal-ai/flux-pro/v1.1-ultra",
  "nano-banana": "fal-ai/nano-banana",
  "nano-banana-edit": "fal-ai/nano-banana/edit",
  "seedream": "fal-ai/bytedance/seedream/v4/text-to-image",
  "seedream-edit": "fal-ai/bytedance/seedream/v4/edit",
  "recraft": "fal-ai/recraft/v3/text-to-image",
};

const resolveModel = (m) => MODELS[m] || m;

// fal kuyruk API'si: gönder -> durum sorgula -> sonucu al
async function runFal(modelId, input, timeoutMs = 240000) {
  const headers = {
    Authorization: `Key ${FAL_KEY}`,
    "Content-Type": "application/json",
  };

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
    const s = await fetch(status_url, { headers });
    const st = await s.json();
    if (st.status === "COMPLETED") {
      const res = await fetch(response_url, { headers });
      if (!res.ok) throw new Error(`fal sonuç hatası ${res.status}: ${await res.text()}`);
      return res.json();
    }
    if (st.status === "FAILED" || st.error) throw new Error(`fal işi başarısız: ${JSON.stringify(st)}`);
  }
  throw new Error("fal zaman aşımı");
}

// Sonuçtaki görselleri MCP içeriğine çevir (URL + küçük önizleme)
async function toContent(result, modelId) {
  const images = result.images || (result.image ? [result.image] : []);
  const content = [];
  const urls = images.map((i) => i.url).filter(Boolean);

  content.push({
    type: "text",
    text: JSON.stringify(
      { model: modelId, image_urls: urls, seed: result.seed ?? null, description: result.description ?? null },
      null,
      2
    ),
  });

  for (const url of urls.slice(0, 4)) {
    try {
      const r = await fetch(url);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 4.5 * 1024 * 1024) continue; // çok büyükse sadece URL
      content.push({
        type: "image",
        data: buf.toString("base64"),
        mimeType: r.headers.get("content-type") || "image/png",
      });
    } catch {
      /* önizleme alınamadıysa URL yeterli */
    }
  }
  return { content };
}

function buildServer() {
  const server = new McpServer({ name: "fal-ai", version: "1.0.0" });

  server.tool(
    "list_models",
    "Kullanılabilir model kısayollarını listeler. Tam fal model ID'si de doğrudan kullanılabilir.",
    {},
    async () => ({ content: [{ type: "text", text: JSON.stringify(MODELS, null, 2) }] })
  );

  server.tool(
    "generate_image",
    "fal.ai ile metinden görsel üretir. model: kısayol (flux-dev, nano-banana, seedream...) veya tam fal model ID'si.",
    {
      prompt: z.string().describe("Görsel promptu"),
      model: z.string().default("flux-dev"),
      image_size: z
        .string()
        .optional()
        .describe("square_hd, square, portrait_4_3, portrait_16_9, landscape_4_3, landscape_16_9 (Flux için)"),
      aspect_ratio: z.string().optional().describe("Örn. 9:16, 1:1, 16:9 (Nano Banana / Flux Ultra için)"),
      num_images: z.number().int().min(1).max(4).default(1),
      seed: z.number().int().optional(),
      extra: z.record(z.any()).optional().describe("Modele özel ek parametreler"),
    },
    async ({ prompt, model, image_size, aspect_ratio, num_images, seed, extra }) => {
      const modelId = resolveModel(model);
      const input = { prompt, num_images, ...(extra || {}) };
      if (image_size) input.image_size = image_size;
      if (aspect_ratio) input.aspect_ratio = aspect_ratio;
      if (seed !== undefined) input.seed = seed;
      try {
        return await toContent(await runFal(modelId, input), modelId);
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: String(e.message || e) }] };
      }
    }
  );

  server.tool(
    "edit_image",
    "Referans görsel(ler) ile düzenleme/üretim yapar (nano-banana-edit, seedream-edit vb.).",
    {
      prompt: z.string(),
      image_urls: z.array(z.string().url()).min(1).describe("Herkese açık görsel URL'leri"),
      model: z.string().default("nano-banana-edit"),
      num_images: z.number().int().min(1).max(4).default(1),
      extra: z.record(z.any()).optional(),
    },
    async ({ prompt, image_urls, model, num_images, extra }) => {
      const modelId = resolveModel(model);
      const input = { prompt, image_urls, num_images, ...(extra || {}) };
      try {
        return await toContent(await runFal(modelId, input), modelId);
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: String(e.message || e) }] };
      }
    }
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/", (_req, res) => res.send("fal MCP çalışıyor"));

// Gizli yol: https://senin-domainin/<MCP_SECRET>/mcp
app.post(`/${MCP_SECRET}/mcp`, async (req, res) => {
  try {
    const server = buildServer();
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

// Stateless modda GET/DELETE desteklenmiyor
const notAllowed = (_req, res) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
app.get(`/${MCP_SECRET}/mcp`, notAllowed);
app.delete(`/${MCP_SECRET}/mcp`, notAllowed);

app.listen(PORT, () => console.log(`fal MCP :${PORT} portunda`));
