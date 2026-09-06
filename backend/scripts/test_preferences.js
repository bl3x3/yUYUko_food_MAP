const assert = require('assert/strict');
const { randomUUID } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-preferences-'));
process.env.DB_FILE = path.join(tempDirectory, 'preferences.sqlite');
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';
process.env.SILICONFLOW_API_KEY = '';
process.env.DEEPSEEK_API_KEY = '';
// Exercise real JWT/user checks using the existing Redis-unavailable path, with no external services.
require.cache[require.resolve('../redis')] = { exports: { isReady: () => false } };

const database = require('../db');
const { db, init } = database;
const vectorAvailable = database.isVectorSearchAvailable;
let simulateMissingExtension = false;
database.isVectorSearchAvailable = () => !simulateMissingExtension && vectorAvailable();
const { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } = require('../services/aiClients');
const preferences = require('../services/userPreferenceService');
const favoritesRouter = require('../routes/favorites');
const preferencesRouter = require('../routes/preferences');
const { initUserPreferenceSchema } = require('../services/userPreferenceSchema');

function makeUser(name) {
    const id = randomUUID();
    db._raw.prepare('INSERT INTO User(id, username, password) VALUES (?, ?, ?)').run(id, name, 'unused');
    return id;
}

function makePlace(name) {
    return Number(db._raw.prepare('INSERT INTO Place(name, category) VALUES (?, ?)').run(name, '测试分类').lastInsertRowid);
}

function putVector(placeId, axis, magnitude = 1) {
    const values = new Float32Array(EMBEDDING_DIMENSIONS);
    values[axis] = magnitude;
    db._raw.prepare('DELETE FROM place_vectors WHERE place_id = ?').run(BigInt(placeId));
    db._raw.prepare('INSERT INTO place_vectors(place_id, embedding) VALUES (?, ?)')
        .run(BigInt(placeId), Buffer.from(values.buffer));
    db._raw.prepare('UPDATE Place SET has_vector = 1, vector_updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(placeId);
}

function behavior(placeId, type = 'navigation', channel = 'amap') {
    return { event_id: randomUUID(), place_id: placeId, event_type: type, channel };
}

function near(actual, expected, message) {
    assert.ok(Math.abs(actual - expected) < 1e-5, `${message}: ${actual} vs ${expected}`);
}

async function testFrontendCollection() {
    const source = fs.readFileSync(path.join(__dirname, '../../frontend/src/map/placeBehavior.js'), 'utf8');
    const { sharePlaceContent, copyPlaceContent, recordPlaceBehavior } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    const records = [];
    const options = { data: { url: 'https://example.test/p/1' }, channel: 'place', record: (...args) => records.push(args) };
    let resolveShare;
    const pending = sharePlaceContent({ ...options, nativeShare: () => new Promise((resolve) => { resolveShare = resolve; }) });
    assert.equal(records.length, 0, 'opening native share must not count');
    resolveShare();
    assert.equal(await pending, 'shared');
    assert.deepEqual(records, [['share', 'place']]);
    await sharePlaceContent({ ...options, nativeShare: async () => { throw new Error('cancelled'); } });
    await sharePlaceContent({ ...options, copy: async () => false });
    await copyPlaceContent({ ...options, text: 'info', copy: async () => { throw new Error('denied'); } });
    assert.equal(records.length, 1, 'cancelled share and failed clipboard must not count');
    assert.equal(await sharePlaceContent({ ...options, copy: async () => true }), 'copied');
    assert.deepEqual(records[1], ['share_copy', 'place']);

    const originalFetch = global.fetch;
    const requests = [];
    try {
        global.fetch = async (...args) => { requests.push(args); return { ok: true }; };
        await recordPlaceBehavior('https://example.test', '', 1, 'navigation', 'amap');
        await recordPlaceBehavior('https://example.test', 'token', 'amap-poi-id', 'navigation', 'amap');
        assert.equal(requests.length, 0, 'anonymous users and unregistered POIs must not be collected');
        assert.equal(await recordPlaceBehavior('https://example.test', 'token', 1, 'navigation', 'amap'), true);
        assert.equal(requests[0][1].keepalive, true, 'navigation collection must survive page departure');
        assert.equal(requests[0][1].headers.Authorization, 'Bearer token');
        assert.equal(JSON.parse(requests[0][1].body).event_type, 'navigation');
        global.fetch = () => { throw new Error('network unavailable'); };
        assert.equal(await recordPlaceBehavior('https://example.test', 'token', 1, 'navigation', 'amap'), false);
    } finally { global.fetch = originalFetch; }
}

async function main() {
    let server;
    let stopWorker;
    try {
        init();
        init();
        assert.ok(vectorAvailable(), 'the installed sqlite-vec extension is required for vector integration tests');
        const alice = makeUser('preference-alice');
        const bob = makeUser('preference-bob');
        const legacy = makeUser('preference-existing-favorites');
        const first = makePlace('火锅');
        const second = makePlace('甜品');
        const missing = makePlace('尚未生成向量');
        putVector(first, 0, 10);
        putVector(second, 1, 0.1);
        assert.equal(preferences.getUserPreference(bob).status, 'empty');
        assert.equal(preferences.getUserPreference(bob).vector, null);

        db._raw.prepare('INSERT INTO Favorite(user_id, place_id) VALUES (?, ?)').run(legacy, first);
        db._raw.prepare('DELETE FROM UserPreference WHERE user_id = ?').run(legacy);
        initUserPreferenceSchema(db._raw);
        stopWorker = preferences.startUserVectorWorker();
        preferences.refreshUserVectorBatch();
        await new Promise(setImmediate);
        const legacyRow = db._raw.prepare('SELECT * FROM UserPreference WHERE user_id = ?').get(legacy);
        assert.equal(legacyRow.status, 'ready', 'existing favorites should be built without visiting an endpoint');
        assert.equal(legacyRow.total_weight, 5);
        assert.equal(db._raw.prepare('SELECT COUNT(*) AS n FROM UserBehaviorEvent WHERE user_id = ?').get(legacy).n, 0);

        const app = express();
        app.use(express.json());
        app.use('/api/favorites', favoritesRouter);
        app.use('/api/preferences', preferencesRouter);
        app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
        server = await new Promise((resolve) => {
            const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
        });
        const base = `http://127.0.0.1:${server.address().port}`;
        const request = async (route, method = 'GET', body, userId = alice) => {
            const headers = { 'Content-Type': 'application/json' };
            if (userId) headers.Authorization = `Bearer ${jwt.sign({ id: userId }, process.env.JWT_SECRET || 'yuyuko_secret_key', { expiresIn: 3600 })}`;
            const response = await fetch(`${base}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            return { status: response.status, headers: response.headers, body: await response.json() };
        };
        assert.equal((await request('/api/preferences/events', 'POST', behavior(first), null)).status, 401);
        assert.equal((await request('/api/preferences/me', 'GET', undefined, null)).status, 401);
        assert.equal((await request('/api/favorites/1garbage', 'POST')).status, 400);
        assert.equal((await request('/api/favorites/999999', 'POST')).status, 404);
        const favoriteResults = await Promise.all(Array.from({ length: 6 }, () => request(`/api/favorites/${first}`, 'POST')));
        assert.ok(favoriteResults.every((result) => result.status === 200));
        assert.equal(db._raw.prepare("SELECT COUNT(*) AS n FROM UserBehaviorEvent WHERE user_id = ? AND event_type = 'favorite_add'").get(alice).n, 1);
        assert.equal(preferences.getUserPreference(alice).total_weight, 5);

        // Failure to append the event must roll back the favorite itself.
        db._raw.exec("CREATE TRIGGER reject_test_favorite BEFORE INSERT ON UserBehaviorEvent WHEN NEW.event_type = 'favorite_add' BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
        assert.throws(() => preferences.changeFavorite(bob, first, true), /test rollback/);
        assert.equal(db._raw.prepare('SELECT COUNT(*) AS n FROM Favorite WHERE user_id = ?').get(bob).n, 0);
        db._raw.exec('DROP TRIGGER reject_test_favorite');

        const navigation = { ...behavior(second), user_id: bob, occurred_at: 0, weight: 99999 };
        const navResults = await Promise.all(Array.from({ length: 6 }, () => request('/api/preferences/events', 'POST', navigation)));
        assert.equal(navResults.filter((result) => result.status === 201).length, 1);
        const navRow = db._raw.prepare('SELECT * FROM UserBehaviorEvent WHERE event_id = ?').get(navigation.event_id);
        assert.equal(navRow.user_id, alice, 'user identity must come from JWT');
        assert.ok(navRow.occurred_at > Date.now() - 60000, 'timestamp must come from server');
        assert.equal((await request('/api/preferences/events', 'POST', { ...navigation, place_id: first })).status, 409);
        const cooldownPayload = behavior(second, 'navigation', 'google');
        const cooldown = await request('/api/preferences/events', 'POST', cooldownPayload);
        assert.equal(cooldown.body.counted, false, 'switching navigation app must share the cooldown');
        assert.equal(cooldown.body.reason, 'cooldown');
        assert.equal((await request('/api/preferences/events', 'POST', cooldownPayload)).body.reason, 'duplicate');
        assert.equal((await request('/api/preferences/events', 'POST', behavior(first, 'favorite_add', 'favorite'))).status, 400);
        assert.equal((await request('/api/preferences/events', 'POST', behavior(first, 'navigation', 'made-up'))).status, 400);
        assert.equal((await request('/api/preferences/events', 'POST', behavior(999999))).status, 404);
        assert.equal((await request('/api/preferences/events', 'POST', { ...behavior(first), event_id: 'bad' })).status, 400);
        db._raw.prepare('UPDATE User SET is_banned = 1 WHERE id = ?').run(bob);
        assert.equal((await request('/api/preferences/events', 'POST', behavior(first), bob)).status, 403);
        db._raw.prepare('UPDATE User SET is_banned = 0 WHERE id = ?').run(bob);

        const response = await request('/api/preferences/me');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const profile = response.body;
        assert.equal(profile.status, 'ready');
        assert.equal(profile.model, EMBEDDING_MODEL);
        assert.equal(profile.vector.length, EMBEDDING_DIMENSIONS);
        assert.equal(profile.vector_place_count, 2);
        near(Math.hypot(...profile.vector), 1, 'user vector must be unit length');
        near(profile.vector[1] / profile.vector[0], 3 * Math.log(2) / 5, 'item magnitude must not override behavior weight');
        assert.equal((await request('/api/preferences/me?user_id=' + alice, 'GET', undefined, bob)).body.vector, null);

        await request(`/api/favorites/${first}`, 'DELETE');
        await request(`/api/favorites/${first}`, 'DELETE');
        near(preferences.getUserPreference(alice).vector[0], 0, 'unfavorite must remove the persistent baseline');
        assert.equal(db._raw.prepare("SELECT COUNT(*) AS n FROM UserBehaviorEvent WHERE user_id = ? AND event_type = 'favorite_remove'").get(alice).n, 1);
        preferences.changeFavorite(alice, first, true);
        preferences.recordBehavior(alice, behavior(second, 'share', 'place'));
        preferences.recordBehavior(alice, behavior(second, 'share_copy', 'place_info'));
        let weighted = preferences.getUserPreference(alice);
        near(weighted.vector[1] / weighted.vector[0], 6 * Math.log(2) / 5, 'navigation, share and clipboard have distinct contributions');
        db._raw.prepare("UPDATE UserBehaviorEvent SET occurred_at = ? WHERE user_id = ? AND event_type IN ('navigation', 'share', 'share_copy')")
            .run(Date.now() - preferences.HALF_LIFE_MS, alice);
        db._raw.prepare('UPDATE UserPreference SET updated_at = ? WHERE user_id = ?').run(Date.now() - preferences.REFRESH_MS, alice);
        weighted = preferences.getUserPreference(alice);
        near(weighted.vector[1] / weighted.vector[0], 6 * Math.log(1.5) / 5, 'half-life applies to effective counts before log saturation');
        assert.equal(preferences.placeWeight(true, { navigation: 100000, share: 100000 }), preferences.MAX_PLACE_WEIGHT);

        const cooldownUser = makeUser('cooldown-boundary');
        const initialNavigation = behavior(first);
        preferences.recordBehavior(cooldownUser, initialNavigation);
        const suppressedNavigation = behavior(first);
        assert.equal(preferences.recordBehavior(cooldownUser, suppressedNavigation).counted, false);
        db._raw.prepare('UPDATE UserBehaviorEvent SET occurred_at = ? WHERE user_id = ?').run(Date.now() - preferences.DEDUPE_MS - 1, cooldownUser);
        assert.equal(preferences.recordBehavior(cooldownUser, suppressedNavigation).reason, 'duplicate', 'a suppressed event ID must stay idempotent after cooldown');
        assert.equal(preferences.recordBehavior(cooldownUser, behavior(first)).counted, true, 'a new operation after cooldown should count');

        preferences.changeFavorite(legacy, first, false);
        preferences.recordBehavior(legacy, behavior(first));
        db._raw.prepare('UPDATE UserBehaviorEvent SET occurred_at = ? WHERE user_id = ?').run(Date.now() - 181 * 86400000, legacy);
        assert.equal(preferences.getUserPreference(legacy).status, 'empty', 'expired historical actions should stop influencing the vector');

        preferences.changeFavorite(bob, missing, true);
        assert.equal(preferences.getUserPreference(bob).status, 'pending');
        assert.equal(preferences.getUserPreference(bob).source_place_count, 1);
        putVector(missing, 2);
        assert.equal(preferences.getUserPreference(bob).status, 'ready', 'a completed place vector invalidates the user vector');
        db._raw.prepare('UPDATE Place SET has_vector = 0 WHERE id = ?').run(missing);
        assert.equal(preferences.getUserPreference(bob).vector, null, 'stale place vectors must be excluded');
        putVector(missing, 2, 0);
        assert.equal(preferences.getUserPreference(bob).vector, null, 'zero vectors must not produce NaNs');
        putVector(missing, 2);
        simulateMissingExtension = true;
        db._raw.prepare('UPDATE UserPreference SET dirty = 1 WHERE user_id = ?').run(bob);
        assert.equal(preferences.getUserPreference(bob).status, 'unavailable');
        assert.equal(preferences.recordBehavior(bob, behavior(missing)).counted, true, 'collection must work while sqlite-vec is unavailable');
        simulateMissingExtension = false;
        db._raw.prepare('UPDATE UserPreference SET dirty = 1 WHERE user_id = ?').run(bob);
        assert.equal(preferences.getUserPreference(bob).status, 'ready');

        const limited = makeUser('rate-limited');
        for (let index = 0; index < 60; index += 1) preferences.recordBehavior(limited, behavior(first));
        assert.throws(() => preferences.recordBehavior(limited, behavior(first)), (error) => error.status === 429);
        assert.equal(db._raw.prepare('SELECT SUM(contributes) AS n FROM UserBehaviorEvent WHERE user_id = ?').get(limited).n, 1);

        db._raw.prepare('DELETE FROM Place WHERE id = ?').run(missing);
        assert.equal(preferences.getUserPreference(bob).status, 'empty', 'deleted places must disappear from the profile');
        assert.equal(db._raw.prepare('SELECT COUNT(*) AS n FROM UserBehaviorEvent WHERE place_id = ?').get(missing).n, 0);
        db._raw.prepare('DELETE FROM User WHERE id = ?').run(alice);
        assert.equal(db._raw.prepare('SELECT COUNT(*) AS n FROM UserBehaviorEvent WHERE user_id = ?').get(alice).n, 0);
        assert.equal(db._raw.prepare('SELECT COUNT(*) AS n FROM UserPreference WHERE user_id = ?').get(alice).n, 0);
        init();
        assert.equal(db._raw.prepare('SELECT COUNT(*) AS n FROM UserPreference WHERE user_id = ?').get(alice).n, 0, 'orphan legacy favorites cannot recreate a deleted user profile');
        await testFrontendCollection();
        console.log('Preference collection, JWT isolation, migration, vector math, lifecycle and frontend sharing tests passed.');
    } finally {
        if (stopWorker) stopWorker();
        if (server) await new Promise((resolve) => server.close(resolve));
        await new Promise(setImmediate);
        db.close();
        // Only this uniquely created temporary fixture directory is removed.
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
