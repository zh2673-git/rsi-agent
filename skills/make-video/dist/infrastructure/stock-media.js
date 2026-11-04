// 真实素材接入（可选，默认关闭）：零配置时零网络、零付费，只用代码绘制。
// 只有用户显式配置了 Pexels 免费 key 并调用 `stock` 命令，才会联网检索并下载素材。
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ensureDir } from './fs-utils.js';
export const STOCK_HINT = '未配置真实素材图库密钥（MAKEVIDEO_PEXELS_API_KEY），默认只用代码绘制。' +
    '如需真实素材：1) 在 pexels.com 免费注册并获取 API key（免费额度，无需付费）；' +
    '2) 设置环境变量 MAKEVIDEO_PEXELS_API_KEY 后重试；' +
    '3) 或者直接把自有图片/视频放进 materials/ 并用 add-material 入库。';
function apiKey() {
    const key = process.env['MAKEVIDEO_PEXELS_API_KEY'] ?? process.env['PEXELS_API_KEY'];
    return key && key.trim().length > 0 ? key.trim() : undefined;
}
export function stockEnabled() {
    return Boolean(apiKey());
}
async function request(url, init = {}) {
    const key = apiKey();
    if (!key)
        throw new Error(STOCK_HINT);
    const res = await fetch(url, {
        ...init,
        headers: { Authorization: key, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) {
        throw new Error(`素材库请求失败（HTTP ${res.status}）：${await res.text().catch(() => '')}`);
    }
    return res;
}
export async function searchStock(query, opts = {}) {
    if (!stockEnabled()) {
        return { enabled: false, provider: 'pexels', items: [], hint: STOCK_HINT };
    }
    const count = Math.min(Math.max(opts.count ?? 3, 1), 20);
    const type = opts.type ?? 'image';
    const endpoint = type === 'video'
        ? 'https://api.pexels.com/videos/search'
        : 'https://api.pexels.com/v1/search';
    const url = `${endpoint}?query=${encodeURIComponent(query)}&per_page=${count}&orientation=landscape`;
    const res = await request(url);
    const data = (await res.json());
    if (type === 'video') {
        const videos = data['videos'] ?? [];
        const items = videos.map((v) => {
            const files = v['video_files'] ?? [];
            const best = files.find((f) => (f.width ?? 0) >= 1920) ??
                files.slice().sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
            return {
                provider: 'pexels',
                id: String(v['id']),
                type: 'video',
                width: best?.width ?? 0,
                height: best?.height ?? 0,
                downloadUrl: best?.link ?? '',
                pageUrl: String(v['url'] ?? ''),
                author: String(v['user']?.['name'] ?? ''),
                alt: query,
            };
        });
        return { enabled: true, provider: 'pexels', items: items.filter((i) => i.downloadUrl) };
    }
    const photos = data['photos'] ?? [];
    const items = photos.map((p) => {
        const src = p['src'] ?? {};
        return {
            provider: 'pexels',
            id: String(p['id']),
            type: 'image',
            width: Number(p['width'] ?? 0),
            height: Number(p['height'] ?? 0),
            downloadUrl: src['large2x'] ?? src['original'] ?? src['large'] ?? '',
            pageUrl: String(p['url'] ?? ''),
            author: String(p['photographer'] ?? ''),
            alt: String(p['alt'] ?? query),
        };
    });
    return { enabled: true, provider: 'pexels', items: items.filter((i) => i.downloadUrl) };
}
export async function downloadStock(hit, destDir) {
    await ensureDir(destDir);
    const res = await request(hit.downloadUrl);
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = hit.type === 'video' ? '.mp4' : extFromUrl(hit.downloadUrl);
    const file = path.join(destDir, `stock-${hit.provider}-${hit.id}${ext}`);
    await fs.writeFile(file, buf);
    return file;
}
function extFromUrl(url) {
    const m = /\.(jpe?g|png|webp)(?:\?|$)/i.exec(url);
    return m ? `.${m[1].toLowerCase()}` : '.jpg';
}
