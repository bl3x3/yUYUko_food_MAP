const { randomUUID } = require('crypto');
const { db, isVectorSearchAvailable } = require('../db');
const { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } = require('./aiClients');

const ALGORITHM_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const HALF_LIFE_MS = 30 * DAY_MS;
const HISTORY_WINDOW_MS = 180 * DAY_MS;
const DEDUPE_MS = 30 * 60 * 1000;
const REFRESH_MS = 6 * 60 * 60 * 1000;
const MAX_PLACE_WEIGHT = 12;
const BEHAVIOR_WEIGHTS = { navigation: 3, share: 2, share_copy: 1 };
const CHANNELS = {
    navigation: ['system-default', 'apple-maps', 'amap', 'tencent', 'google'],
    share: ['place', 'amap'],
    share_copy: ['place', 'amap', 'place_info']
};

function fail(status, message) {
    const error = new Error(message);
    error.status = status;
    throw error;
}

function validPlaceId(value) {
    return (typeof value === 'string' && /^[1-9]\d*$/.test(value) || typeof value === 'number')
        && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function validateBehavior(payload) {
    if (!payload || !validPlaceId(payload.place_id)) fail(400, '无效的 place_id');
    if (typeof payload.event_type !== 'string' || !Object.hasOwn(CHANNELS, payload.event_type)) fail(400, '不支持的行为类型');
    if (!CHANNELS[payload.event_type].includes(payload.channel)) fail(400, '无效的行为渠道');
    if (typeof payload.event_id !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(payload.event_id)) {
        fail(400, '无效的 event_id');
    }
}

const recordBehaviorTransaction = db._raw.transaction((userId, payload, now) => {
    const placeId = Number(payload.place_id);
    const previous = db._raw.prepare('SELECT place_id, event_type, channel FROM UserBehaviorEvent WHERE user_id = ? AND event_id = ?')
        .get(userId, payload.event_id);
    if (previous) {
        if (previous.place_id !== placeId || previous.event_type !== payload.event_type || previous.channel !== payload.channel) {
            fail(409, 'event_id 已用于其他行为');
        }
        return { recorded: false, reason: 'duplicate' };
    }
    if (!db._raw.prepare('SELECT id FROM Place WHERE id = ?').get(placeId)) fail(404, '地点不存在');
    const recent = db._raw.prepare(`SELECT id FROM UserBehaviorEvent
        WHERE user_id = ? AND place_id = ? AND event_type = ? AND contributes = 1 AND occurred_at > ? LIMIT 1`)
        .get(userId, placeId, payload.event_type, now - DEDUPE_MS);
    const rate = db._raw.prepare('SELECT COUNT(*) AS count FROM UserBehaviorEvent WHERE user_id = ? AND occurred_at > ?')
        .get(userId, now - 60000);
    if (rate.count >= 60) fail(429, '操作过于频繁，请稍后再试');
    db._raw.prepare(`INSERT INTO UserBehaviorEvent(user_id, place_id, event_id, event_type, channel, occurred_at, contributes)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(userId, placeId, payload.event_id, payload.event_type, payload.channel, now, recent ? 0 : 1);
    return { recorded: true, counted: !recent, ...(recent ? { reason: 'cooldown' } : {}) };
});

function recordBehavior(userId, payload) {
    validateBehavior(payload);
    // The client cannot choose the acting user, timestamp, weight or vector.
    const result = recordBehaviorTransaction.immediate(userId, payload, Date.now());
    if (result.counted) queueUserVectorRefresh(userId);
    return result;
}

const changeFavoriteTransaction = db._raw.transaction((userId, placeId, favorite) => {
    if (favorite && !db._raw.prepare('SELECT id FROM Place WHERE id = ?').get(placeId)) fail(404, '地点不存在');
    const result = favorite
        ? db._raw.prepare('INSERT OR IGNORE INTO Favorite(user_id, place_id) VALUES (?, ?)').run(userId, placeId)
        : db._raw.prepare('DELETE FROM Favorite WHERE user_id = ? AND place_id = ?').run(userId, placeId);
    if (result.changes && db._raw.prepare('SELECT id FROM Place WHERE id = ?').get(placeId)) {
        db._raw.prepare(`INSERT INTO UserBehaviorEvent(user_id, place_id, event_id, event_type, channel, occurred_at)
            VALUES (?, ?, ?, ?, 'favorite', ?)`).run(userId, placeId, randomUUID(), favorite ? 'favorite_add' : 'favorite_remove', Date.now());
    }
    return result.changes > 0;
});

function changeFavorite(userId, placeId, favorite) {
    if (!validPlaceId(placeId)) fail(400, '无效的 placeId');
    const changed = changeFavoriteTransaction.immediate(userId, Number(placeId), favorite);
    if (changed) queueUserVectorRefresh(userId);
    return changed;
}

function normalizeVector(vector) {
    if (!vector || vector.length !== EMBEDDING_DIMENSIONS) return null;
    let squaredNorm = 0;
    for (const value of vector) {
        if (!Number.isFinite(value)) return null;
        squaredNorm += value * value;
    }
    const norm = Math.sqrt(squaredNorm);
    if (!Number.isFinite(norm) || norm <= 1e-12) return null;
    return Float32Array.from(vector, (value) => value / norm);
}

function decodeVector(blob) {
    if (!Buffer.isBuffer(blob) || blob.length !== EMBEDDING_DIMENSIONS * 4) return null;
    const vector = new Float32Array(EMBEDDING_DIMENSIONS);
    for (let index = 0; index < vector.length; index += 1) vector[index] = blob.readFloatLE(index * 4);
    return normalizeVector(vector);
}

function placeWeight(favorite, counts) {
    let weight = favorite ? 5 : 0;
    for (const [type, base] of Object.entries(BEHAVIOR_WEIGHTS)) weight += base * Math.log1p(counts[type] || 0);
    return Math.min(MAX_PLACE_WEIGHT, weight);
}

const rebuildUserVectorTransaction = db._raw.transaction((userId, now) => {
    if (!db._raw.prepare('SELECT id FROM User WHERE id = ?').get(userId)) return null;
    const signals = new Map();
    const signalFor = (placeId) => {
        if (!signals.has(placeId)) signals.set(placeId, { favorite: false, counts: {} });
        return signals.get(placeId);
    };
    db._raw.prepare('SELECT f.place_id FROM Favorite f JOIN Place p ON p.id = f.place_id WHERE f.user_id = ?')
        .all(userId).forEach(({ place_id }) => { signalFor(place_id).favorite = true; });
    const events = db._raw.prepare(`SELECT e.place_id, e.event_type, e.occurred_at
        FROM UserBehaviorEvent e JOIN Place p ON p.id = e.place_id
        WHERE e.user_id = ? AND e.occurred_at >= ? AND e.occurred_at <= ?
            AND e.contributes = 1
            AND e.event_type IN ('navigation', 'share', 'share_copy')`).iterate(userId, now - HISTORY_WINDOW_MS, now);
    for (const event of events) {
        const signal = signalFor(event.place_id);
        const decay = 2 ** (-(now - event.occurred_at) / HALF_LIFE_MS);
        signal.counts[event.event_type] = (signal.counts[event.event_type] || 0) + decay;
    }

    const sum = new Float64Array(EMBEDDING_DIMENSIONS);
    let vectorPlaceCount = 0;
    let totalWeight = 0;
    const available = isVectorSearchAvailable();
    const readVector = available ? db._raw.prepare(`SELECT v.embedding FROM place_vectors v
        JOIN Place p ON p.id = v.place_id WHERE v.place_id = ? AND p.has_vector = 1`) : null;
    for (const [placeId, signal] of signals) {
        const vector = decodeVector(readVector?.get(BigInt(placeId))?.embedding);
        if (!vector) continue;
        const weight = placeWeight(signal.favorite, signal.counts);
        for (let index = 0; index < sum.length; index += 1) sum[index] += weight * vector[index];
        vectorPlaceCount += 1;
        totalWeight += weight;
    }
    const vector = normalizeVector(sum);
    const status = !signals.size ? 'empty' : !available ? 'unavailable' : vector ? 'ready' : 'pending';
    const blob = vector ? Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength) : null;
    db._raw.prepare(`INSERT INTO UserPreference(user_id, vector, model, dimensions, algorithm_version,
        status, source_place_count, vector_place_count, total_weight, updated_at, dirty)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(user_id) DO UPDATE SET vector = excluded.vector, model = excluded.model,
            dimensions = excluded.dimensions, algorithm_version = excluded.algorithm_version,
            status = excluded.status, source_place_count = excluded.source_place_count,
            vector_place_count = excluded.vector_place_count, total_weight = excluded.total_weight,
            updated_at = excluded.updated_at, dirty = 0`)
        .run(userId, blob, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, ALGORITHM_VERSION, status,
            signals.size, vectorPlaceCount, totalWeight, now);
    return db._raw.prepare('SELECT * FROM UserPreference WHERE user_id = ?').get(userId);
});

function getUserPreference(userId) {
    const now = Date.now();
    let row = db._raw.prepare('SELECT * FROM UserPreference WHERE user_id = ?').get(userId);
    if (!row || row.dirty || row.model !== EMBEDDING_MODEL || row.dimensions !== EMBEDDING_DIMENSIONS
        || row.algorithm_version !== ALGORITHM_VERSION || now - row.updated_at >= REFRESH_MS) {
        row = rebuildUserVectorTransaction.immediate(userId, now);
    }
    if (!row) return null;
    const vector = decodeVector(row.vector);
    return {
        status: row.status,
        vector: vector ? Array.from(vector) : null,
        model: row.model,
        dimensions: row.dimensions,
        algorithm_version: row.algorithm_version,
        source_place_count: row.source_place_count,
        vector_place_count: row.vector_place_count,
        total_weight: row.total_weight,
        updated_at: row.updated_at
    };
}

const queuedUsers = new Map();
function queueUserVectorRefresh(userId) {
    if (queuedUsers.has(userId)) return;
    const handle = setImmediate(() => {
        queuedUsers.delete(userId);
        try { getUserPreference(userId); } catch (error) {
            console.warn('User vector refresh failed:', error.message);
        }
    });
    queuedUsers.set(userId, handle);
}

function refreshUserVectorBatch(limit = 20) {
    const users = db._raw.prepare(`SELECT user_id FROM UserPreference
        WHERE dirty = 1 OR updated_at IS NULL OR updated_at <= ? OR model <> ? OR algorithm_version <> ?
        ORDER BY dirty DESC, COALESCE(updated_at, 0), user_id LIMIT ?`)
        .all(Date.now() - REFRESH_MS, EMBEDDING_MODEL, ALGORITHM_VERSION, limit);
    for (const { user_id } of users) queueUserVectorRefresh(user_id);
    return users.length;
}

function startUserVectorWorker() {
    const run = () => {
        try { refreshUserVectorBatch(); } catch (error) { console.warn('User vector worker failed:', error.message); }
    };
    const initial = setTimeout(run, 1000);
    const interval = setInterval(run, 60000);
    initial.unref?.();
    interval.unref?.();
    return () => {
        clearTimeout(initial);
        clearInterval(interval);
        for (const handle of queuedUsers.values()) clearImmediate(handle);
        queuedUsers.clear();
    };
}

module.exports = {
    recordBehavior, changeFavorite, getUserPreference, startUserVectorWorker, refreshUserVectorBatch,
    placeWeight, ALGORITHM_VERSION, HALF_LIFE_MS, DEDUPE_MS, REFRESH_MS, MAX_PLACE_WEIGHT
};
