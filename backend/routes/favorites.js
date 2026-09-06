const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { changeFavorite } = require('../services/userPreferenceService');

// All favorites routes require authentication
router.use(requireAuth);

// GET /api/favorites - return list of favorited places (with full place details) for the current user
router.get('/', (req, res) => {
    const userId = req.user.id;
    db.all(
        `SELECT f.place_id, f.created_time,
                p.name, p.longitude, p.latitude, p.category, p.description
         FROM Favorite f
         LEFT JOIN Place p ON f.place_id = p.id
         WHERE f.user_id = ?
         ORDER BY f.created_time DESC`,
        [userId],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});

// POST /api/favorites/:placeId - add a favorite
router.post('/:placeId', (req, res, next) => {
    try {
        changeFavorite(req.user.id, req.params.placeId, true);
        res.json({ success: true, place_id: Number(req.params.placeId) });
    } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        next(error);
    }
});

// DELETE /api/favorites/:placeId - remove a favorite
router.delete('/:placeId', (req, res, next) => {
    try {
        changeFavorite(req.user.id, req.params.placeId, false);
        res.json({ success: true, place_id: Number(req.params.placeId) });
    } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        next(error);
    }
});

module.exports = router;
