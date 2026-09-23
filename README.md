# fal.ai MCP Sunucusu — Kurulum

## 1. Yerelde dene
```bash
npm install
FAL_KEY=xxx MCP_SECRET=uzun-rastgele-bir-dize npm start
```
Test: `npx @modelcontextprotocol/inspector` ile `http://localhost:3000/<MCP_SECRET>/mcp` adresine bağlan.

`MCP_SECRET` üretmek için: `openssl rand -hex 24`

## 2. Deploy (Railway örneği)
1. Klasörü bir GitHub reposuna yükle.
2. railway.app → New Project → Deploy from GitHub repo.
3. Variables: `FAL_KEY` ve `MCP_SECRET` ekle.
4. Settings → Networking → Generate Domain.

Render.com veya Fly.io da aynı şekilde çalışır (Node 18+, start komutu `npm start`).

## 3. Claude'a bağla
claude.ai → Ayarlar → Connectors → **Add custom connector**
URL: `https://<domainin>/<MCP_SECRET>/mcp`

Sohbette connector'ı açtıktan sonra örnek:
> nano-banana ile 9:16, kırmızı arka planda uçan bir kulaklık üret

## Araçlar
- `generate_image` — prompt, model, image_size / aspect_ratio, num_images, seed, extra
- `edit_image` — prompt + image_urls (referans görseller)
- `list_models` — kısayollar

Model eklemek için `server.js` içindeki `MODELS` nesnesine satır ekle, ya da doğrudan tam ID ver (örn. `fal-ai/ideogram/v3`).

## Güvenlik notu
URL'deki `MCP_SECRET` şifre gibidir: URL'yi bilen herkes senin fal kredinle görsel üretebilir. Paylaşma. Sızarsa değiştir.
fal panelinden harcama limiti koymanı öneririm.
