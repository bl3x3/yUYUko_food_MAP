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
    return parts.join(" · ") || place?.name || "东方饭联地图地点";
}

function getOgImageUrl(place, frontendBase) {
    // 优先使用地点的第一张外观图片
    try {
        const exteriorImages = JSON.parse(place?.exterior_images || '[]');
        if (Array.isArray(exteriorImages) && exteriorImages.length > 0) {
            const img = exteriorImages[0];
            if (img && typeof img === 'string') {
                // 相对路径补全为绝对路径
                if (img.startsWith('/')) return `${frontendBase}${img}`;
                if (img.startsWith('http')) return img;
                return `${frontendBase}/${img}`;
            }
        }
    } catch (e) { /* ignore */ }
    // 回退：favicon
    return `${frontendBase}/favicon.ico`;
}

function renderShareHtml(place, shareUrl, frontendUrl, isNavShare) {
    const siteName = '东方饭联地图';
    const placeName = place.name || '地点';

    // <title>: max 65 chars
    const pageTitle = truncate(`${placeName} | ${siteName}`, 65);
    // meta description: max 155 chars
    const metaDesc = truncate(buildOgDescription(place), 155);
    // og:title: max 35 chars
    const ogTitle = truncate(placeName, 35);
    // og:description: max 65 chars
    const ogDesc = truncate(buildOgDescription(place), 65);

    const safePageTitle = htmlEscape(pageTitle);
    const safeMetaDesc = htmlEscape(metaDesc);
    const safeOgTitle = htmlEscape(ogTitle);
    const safeOgDesc = htmlEscape(ogDesc);
    const safeName = htmlEscape(placeName);
    const safeAddress = htmlEscape(place.address || "");
    const safeFrontendUrl = htmlEscape(frontendUrl);
    const safeShareUrl = htmlEscape(shareUrl);

    const frontendBase = frontendUrl.replace(/\/\?.*$/, '').replace(/\/$/, '');
    const ogImageUrl = getOgImageUrl(place, frontendBase);

    const actionLabel = isNavShare ? "打开高德地图导航" : "在地图中查看";
    const actionUrl = isNavShare ? htmlEscape(buildAmapNavUrl(place)) : safeFrontendUrl;

    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safePageTitle}</title>
  <meta name="description" content="${safeMetaDesc}" />

  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="${htmlEscape(siteName)}" />
  <meta property="og:title" content="${safeOgTitle}" />
  <meta property="og:description" content="${safeOgDesc}" />
  <meta itemprop="description" content="${safeOgDesc}" />
  <meta property="og:url" content="${safeShareUrl}" />
  <meta property="og:image" content="${htmlEscape(ogImageUrl)}" />
  <meta property="og:image:width" content="600" />
  <meta property="og:image:height" content="315" />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${safeOgTitle}" />
  <meta name="twitter:description" content="${safeOgDesc}" />
  <meta name="twitter:image" content="${htmlEscape(ogImageUrl)}" />

  <style>
    body { margin:0; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; background:#f4f7fb; color:#102a43; }
    .wrap { max-width: 760px; margin: 40px auto; padding: 24px; }
    .card { background:white; border-radius:16px; padding:24px; box-shadow:0 8px 40px rgba(16,42,67,0.12); }
    h1 { margin: 0 0 12px; font-size: 32px; }
    p { margin: 8px 0; line-height: 1.6; }
    .meta { color:#486581; }
    .btn { display:inline-block; margin-top:16px; background:#0f609b; color:white; text-decoration:none; padding:10px 16px; border-radius:10px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>${safeName}</h1>
      <p class="meta">${safeMetaDesc}</p>
      ${safeAddress ? `<p>📍 ${safeAddress}</p>` : ""}
      <a class="btn" href="${actionUrl}">${actionLabel}</a>
    </div>
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

        const shareUrl = buildFrontendPlaceUrl(req, placeId).replace(/\/\?.*$/, '') + req.originalUrl;
        const frontendUrl = buildFrontendPlaceUrl(req, placeId);

        if (isNavShare) {
            const amapUrl = buildAmapNavUrl(place);
            if (isBot) {
                res.set("Content-Type", "text/html; charset=utf-8");
                return res.send(renderShareHtml(place, shareUrl, frontendUrl, true));
            }
            return res.redirect(302, amapUrl);
        }

        if (isBot) {
            res.set("Content-Type", "text/html; charset=utf-8");
            return res.send(renderShareHtml(place, shareUrl, frontendUrl, false));
        }

        return res.redirect(302, frontendUrl);
    });
});

module.exports = router;
