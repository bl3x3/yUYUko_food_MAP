const express = require("express");
const router = express.Router();
const { db } = require("../../db");
const requireAdmin = require("../../middleware/adminAuth");
const { logAdminAction } = require("../../utils/adminAudit");

// 列出所有白名单QQ号
router.get("/", requireAdmin("manage_invites"), (req, res) => {
    db.all("SELECT id, qq, created_time FROM QQWhitelist ORDER BY created_time DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// 添加白名单QQ号（支持单个或批量）
router.post("/", requireAdmin("manage_invites"), (req, res) => {
    const { qq } = req.body;
    // 支持逗号、换行、空格分隔的批量导入
    const qqList = String(qq || "").split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    if (qqList.length === 0) return res.status(400).json({ error: "缺少 qq 字段" });

    const added = [];
    const skipped = [];
    for (const qqNum of qqList) {
        // 基本校验：仅允许纯数字，长度 5-15
        if (!/^\d{5,15}$/.test(qqNum)) {
            skipped.push({ qq: qqNum, reason: "格式无效" });
            continue;
        }
        try {
            db.run("INSERT INTO QQWhitelist (qq) VALUES (?)", [qqNum]);
            added.push(qqNum);
        } catch (e) {
            if (e.message && e.message.includes("UNIQUE")) {
                skipped.push({ qq: qqNum, reason: "已存在" });
            } else {
                skipped.push({ qq: qqNum, reason: e.message });
            }
        }
    }

    // 记录操作日志
    logAdminAction(req.user && req.user.id, "manage-qq-whitelist", null, JSON.stringify({ added, skipped }));

    res.json({ added, skipped });
});

// 删除白名单QQ号
router.delete("/:id", requireAdmin("manage_invites"), (req, res) => {
    const id = req.params.id;
    db.get("SELECT id, qq FROM QQWhitelist WHERE id = ?", [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "白名单记录不存在" });
        db.run("DELETE FROM QQWhitelist WHERE id = ?", [id], function (e) {
            if (e) return res.status(500).json({ error: e.message });
            logAdminAction(req.user && req.user.id, "delete-qq-whitelist", null, JSON.stringify({ id, qq: row.qq }));
            res.json({ success: true });
        });
    });
});

module.exports = router;
