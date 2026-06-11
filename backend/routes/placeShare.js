const express = require("express");
const router = express.Router();
const { db } = require("../db");

const BOT_UA_REGEX = /bot|spider|crawler|facebookexternalhit|twitterbot|slack|qzone|qq|MicroMessenger|MQQBrowser|WeChat|WxWork|WhatsApp|Line|TelegramBot|Discordbot|DingTalk|Lark|Feishu|Bytedance|Tencent|YisouSpider|Sogou|360Spider|Bytespider|PetalBot/i;

function htmlEscape(text) {
    return String(text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function buildFrontendPlaceUrl(req, id) {
    const placeParam = `/?place=${id}`;
    const configured = process.env.FRONTEND_BASE_URL;
    if (configured) {
        return `${String(configured).replace(/\/+$/, "")}${placeParam}`;
    }

    const protocol = "https";
    const host = (req.get("host") || "").replace(/:\d+$/, "");

    // 本地开发
    if (/^(localhost|127\.0\.0\.1)$/i.test(host)) {
        return `${protocol}://${host}:5173${placeParam}`;
    }

    // 生产环境：使用请求的实际域名（已移除端口号，确保与 dinners 一致）
    return `${protocol}://${host}${placeParam}`;
}

function buildAmapNavUrl(place) {
    const lng = Number(place?.longitude);
    const lat = Number(place?.latitude);
    const label = encodeURIComponent((place?.name || "目的地").trim());
    return `https://uri.amap.com/navigation?to=${lng},${lat},${label}&mode=car&src=yUYUko_food_MAP`;
}

function truncate(str, max) {
    const s = String(str || '');
    return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function buildOgDescription(place) {
    const parts = [];
    if (place?.category) parts.push(place.category);
    if (place?.description) parts.push(place.description);
    const base = parts.join(" · ");
    // QQ 爬虫忽略过短的描述并回退为显示 URL，不足时补站点上下文
    if (base.length >= 30) return base;
    const name = place?.name;
    const suffix = "上东方饭联地图，与饭搭子一起发现身边的美食好店，从此吃饭不踩雷";
    if (name) return `${name} · ${suffix}`;
    return suffix;
}

/**
 * 构建 og:image / itemprop="image" 用的图片绝对 URL
 * @param {object} place - 地点数据
 * @param {string} baseUrl - 前端基础 URL（协议+主机，与 frontendUrl 同源）
 * @returns {string}
 */
function getOgImageUrl(place, baseUrl) {
    try {
        const exteriorImages = JSON.parse(place?.exterior_images || '[]');
        if (Array.isArray(exteriorImages) && exteriorImages.length > 0) {
            const img = exteriorImages[0];
            if (img && typeof img === 'string') {
                if (img.startsWith('/')) return `${baseUrl}${img}`;
                if (img.startsWith('http')) return img;
                return `${baseUrl}/${img}`;
            }
        }
    } catch (e) { /* ignore */ }
    return `${baseUrl}/favicon.ico`;
}

function renderShareHtml(place, shareUrl, frontendUrl, baseUrl, isNavShare) {
    const siteName = '东方饭联地图';
    const placeName = place.name || '地点';

    // <title>: max 65 chars
    const pageTitle = truncate(`${placeName} | ${siteName}`, 65);
    // meta description: max 155 chars
    const metaDesc = truncate(buildOgDescription(place), 155);
    // og:title / itemprop name: max 35 chars
    const ogTitle = truncate(placeName, 35);
    // og:description / itemprop description: max 65 chars
    const ogDesc = truncate(buildOgDescription(place), 65);

    const safePageTitle = htmlEscape(pageTitle);
    const safeMetaDesc = htmlEscape(metaDesc);
    const safeOgTitle = htmlEscape(ogTitle);
    const safeOgDesc = htmlEscape(ogDesc);
    const safeName = htmlEscape(placeName);
    const safeAddress = htmlEscape(place.address || "");
    const safeFrontendUrl = htmlEscape(frontendUrl);
    const safeShareUrl = htmlEscape(shareUrl);

    const ogImageUrl = getOgImageUrl(place, baseUrl);
    const safeOgImageUrl = htmlEscape(ogImageUrl);

    const actionLabel = isNavShare ? "打开高德地图导航" : "在地图中查看";
    const actionUrl = isNavShare ? htmlEscape(buildAmapNavUrl(place)) : safeFrontendUrl;

    const safeCategory = htmlEscape(place.category || "");
    const safeDescription = htmlEscape(place.description || "");
    // JS 跳转目标（不含 HTML 转义，直接用于 JS 字符串）
    const jsRedirectUrl = (isNavShare ? buildAmapNavUrl(place) : frontendUrl)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'");

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safePageTitle}</title>
  <link rel="shortcut icon" href="${safeOgImageUrl}" />

  <!-- 标准 meta description -->
  <meta name="description" content="${safeMetaDesc}" />

  <!-- Open Graph（微信 / Facebook / Telegram 等） -->
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="${htmlEscape(siteName)}" />
  <meta property="og:title" content="${safeOgTitle}" />
  <meta property="og:description" content="${safeOgDesc}" />
  <meta property="og:url" content="${safeShareUrl}" />
  <meta property="og:image" content="${safeOgImageUrl}" />

  <!-- QQ / Qzone 分享卡片（腾讯自定义 itemprop 解析） -->
  <meta itemprop="name" content="${safeOgTitle}" />
  <meta itemprop="description" content="${safeOgDesc}" />
  <meta itemprop="image" content="${safeOgImageUrl}" />

  <style>
    body { margin:0; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; background:#f4f7fb; color:#102a43; }
    .wrap { max-width: 760px; margin: 40px auto; padding: 24px; }
    .card { background:white; border-radius:16px; padding:24px; box-shadow:0 8px 40px rgba(16,42,67,0.12); }
    h1 { margin: 0 0 12px; font-size: 32px; }
    p { margin: 8px 0; line-height: 1.6; }
    .meta { color:#486581; }
    .btn { display:inline-block; margin-top:16px; background:#0f609b; color:white; text-decoration:none; padding:10px 16px; border-radius:10px; }
  </style>
  <script>
    // 正常浏览器自动跳转到目标页；爬虫不执行 JS，会看到完整 meta 标签
    location.replace('${jsRedirectUrl}');
  </script>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>${safeName}</h1>
      ${safeCategory ? `<p class="meta">🏷 ${safeCategory}</p>` : ""}
      ${safeDescription ? `<p class="meta">${safeDescription}</p>` : ""}
      ${safeAddress ? `<p>📍 ${safeAddress}</p>` : ""}
      <a class="btn" href="${actionUrl}">${actionLabel}</a>
    </div>
    <p style="text-align:center;color:#829ab1;margin-top:24px;font-size:14px;">
      东方饭联地图 — 与饭搭子一起发现身边的美食好店
    </p>
  </div>
</body>
</html>`;
}

router.get("/:id", (req, res) => {
    const placeId = req.params.id;
    const isNavShare = req.query.nav === "amap";

    const sql = `SELECT p.*, u.username AS creator_name
                 FROM Place p
                 LEFT JOIN User u ON p.creator_id = u.id
                 WHERE p.id = ?`;

    db.get(sql, [placeId], (err, place) => {
        if (err) return res.status(500).send("Server Error");
        if (!place) return res.status(404).send("地点不存在");

        const isBot = BOT_UA_REGEX.test(req.get("user-agent") || "");

        const rawHost = req.get("host") || "";
        // 去掉端口号：与 buildFrontendPlaceUrl 保持一致，确保 og:image 等 URL 使用标准端口（443）
        const host = rawHost.replace(/:\d+$/, "");
        const proto = (req.get("x-forwarded-proto") || req.protocol || "https");
        const shareUrl = `${proto}://${host}${req.originalUrl}`;
        const frontendUrl = buildFrontendPlaceUrl(req, placeId);
        // 从 frontendUrl 派生 baseUrl，与旧逻辑完全一致，
        // 确保 FRONTEND_BASE_URL 等配置也被正确使用
        const baseUrl = frontendUrl.replace(/\/\?.*$/, '').replace(/\/$/, '');

        // 始终返回带 OG 标签的 HTML，不再使用 302 重定向。
        // 302 会导致浏览器/客户端分享时从最终页面（SPA，无 OG 标签）提取元数据，
        // 而爬虫也可能因为各种原因无法正确解析。现在模仿 Safari 分享方式：
        // 始终返回含全部 meta 的 HTML，正常浏览器通过 JS 跳转到目标页面。
        res.set("Content-Type", "text/html; charset=utf-8");

        if (isNavShare) {
            return res.send(renderShareHtml(place, shareUrl, frontendUrl, baseUrl, true));
        }

        return res.send(renderShareHtml(place, shareUrl, frontendUrl, baseUrl, false));
    });
});

module.exports = router;
