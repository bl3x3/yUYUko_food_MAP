const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { recordBehavior, getUserPreference } = require('../services/userPreferenceService');

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

router.post('/events', (req, res, next) => {
    try {
        const result = recordBehavior(req.user.id, req.body);
        return res.status(result.recorded ? 201 : 200).json(result);
    } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        next(error);
    }
});

router.get('/me', (req, res, next) => {
    try {
        return res.json(getUserPreference(req.user.id));
    } catch (error) { next(error); }
});

module.exports = router;
