const express = require("express");
const router = express.Router();
const { db } = require("../db");

const BOT_UA_REGEX = /bot|spider|crawler|facebookexternalhit|twitterbot|slack|qzone|qq|MicroMessenger|MQQBrowser/i;

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

    const protocol = req.protocol || "https";
    const host = (req.get("host") || "").replace(/:\d+$/, "");

    // 本地开发
    if (/^(localhost|127\.0\.0\.1)$/i.test(host)) {
        return `${protocol}://${host}:5173${placeParam}`;
    }

    // 生产环境：前端在 :8443
    return `${protocol}://${host}:8443${placeParam}`;
}

function buildAmapNavUrl(place) {
    const lng = Number(place?.longitude);
    const lat = Number(place?.latitude);
    const label = encodeURIComponent((place?.name || "目的地").trim());
    return `https://uri.amap.com/navigation?to=${lng},${lat},${label}&mode=car&src=yUYUko_food_MAP`;
}

function buildShareDescription(place) {
    const parts = [];
    if (place?.name) parts.push(place.name);
    if (place?.category) parts.push(place.category);
    if (place?.address) parts.push(place.address);
    return parts.join(" · ") || "东方饭联地图地点";
}

function renderShareHtml(place, shareUrl, frontendUrl, isNavShare) {
    const title = `${place.name || "地点"} | 东方饭联地图`;
    const description = buildShareDescription(place);
    const safeTitle = htmlEscape(title);
    const safeDescription = htmlEscape(description);
    const safeName = htmlEscape(place.name || "未命名地点");
    const safeCategory = htmlEscape(place.category || "未分类");
    const safeAddress = htmlEscape(place.address || "");
    const safeFrontendUrl = htmlEscape(frontendUrl);
    const safeShareUrl = htmlEscape(shareUrl);

    // Simple SVG OG image with place name
    const ogImageSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#0f172a"/>
  <rect x="40" y="40" width="1120" height="550" rx="24" fill="#1e293b"/>
  <text x="600" y="240" text-anchor="middle" fill="#ffffff" font-size="72" font-family="sans-serif" font-weight="bold">${safeName}</text>
  <text x="600" y="320" text-anchor="middle" fill="#94a3b8" font-size="36" font-family="sans-serif">${safeCategory}</text>
  <text x="600" y="380" text-anchor="middle" fill="#64748b" font-size="28" font-family="sans-serif">${safeAddress}</text>
  <text x="600" y="480" text-anchor="middle" fill="#3b82f6" font-size="32" font-family="sans-serif">📍 在地图中查看</text>
</svg>`;

    const ogImageDataUri = `data:image/svg+xml,${encodeURIComponent(ogImageSvg)}`;

    const actionLabel = isNavShare ? "打开高德地图导航" : "在地图中查看";
    const actionUrl = isNavShare ? htmlEscape(buildAmapNavUrl(place)) : safeFrontendUrl;

    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <meta name="description" content="${safeDescription}" />

  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="东方饭联地图" />
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeDescription}" />
  <meta property="og:url" content="${safeShareUrl}" />
  <meta property="og:image" content="${ogImageDataUri}" />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${safeTitle}" />
  <meta name="twitter:description" content="${safeDescription}" />
  <meta name="twitter:image" content="${ogImageDataUri}" />

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
      <p class="meta">${safeDescription}</p>
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

        const shareUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
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
