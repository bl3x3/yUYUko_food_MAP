const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-random-'));
const databasePath = path.join(directory, 'test.sqlite');
process.env.DB_FILE = databasePath;
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';
process.env.SILICONFLOW_API_KEY = '';
process.env.DEEPSEEK_API_KEY = '';
require.cache[require.resolve('../redis')] = { exports: { isReady: () => false, disconnect() {} } };
const database = require('../db');
const { db, init } = database;
const vectorAvailable = database.isVectorSearchAvailable;
let simulateMissingExtension = false;
database.isVectorSearchAvailable = () => !simulateMissingExtension && vectorAvailable();
const { recommendationWeight, nearbyCandidates, drawRecommendation, personalizeCandidates, EMPTY_MESSAGE } = require('../services/randomRecommendation');
const { getUserPreference, ALGORITHM_VERSION } = require('../services/userPreferenceService');
const { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } = require('../services/aiClients');
const placesRouter = require('../routes/places');
const redis = require('../redis');

async function main() {
    let server;
    try {
        init();
        const center = { lat: 0, lng: 0 };
        const degree = 180 / (Math.PI * 6371.0088);
        const insert = db._raw.prepare('INSERT INTO Place (name, latitude, longitude, category) VALUES (?, ?, ?, ?)');
        const ids = [0, 1, 2, 3, 5].map((distance) => Number(insert.run(`店铺${distance}`, 0, distance * degree, '其他').lastInsertRowid));
        insert.run('圆外但矩形内', 4 * degree, 4 * degree, '其他');
        insert.run('刚好超过5km', 0, 5.000001 * degree, '其他');
        insert.run('避雷店铺', 0, 0, '面食, 避雷');
        insert.run('无效坐标', 0, null, '其他');
        insert.run('无效纬度', 91, 0, '其他');

        for (let i = 0; i < 5; i++) {
            db._raw.prepare('INSERT INTO User (id, username) VALUES (?, ?)').run(`u${i}`, `user${i}`);
            db._raw.prepare('INSERT INTO Favorite (user_id, place_id) VALUES (?, ?)').run(`u${i}`, ids[0]);
        }
        const creatorId = 'cd4d174a-89e1-4a87-8dd2-844170adfe3b';
        const editorId = 'd923b8ae-f432-47a8-a690-cf01d450a97a';
        db._raw.prepare('INSERT INTO User (id, username) VALUES (?, ?), (?, ?)')
            .run(creatorId, '地点创建者', editorId, '最后编辑者');
        for (const id of ids) {
            db._raw.prepare('UPDATE Place SET creator_id = ?, updated_by = ? WHERE id = ?').run(creatorId, editorId, id);
        }
        const candidates = nearbyCandidates(db._raw, center);
        assert.deepEqual(candidates.map(({ place }) => place.id).sort((a, b) => a - b), ids);
        assert.equal(candidates.find(({ place }) => place.id === ids[0]).place.favorite_count, 5);
        assert.ok(Math.abs(recommendationWeight({}, 5) - 9 / 7) < 1e-12);
        assert.equal(recommendationWeight({}, 0), 2, 'missing details and favorites keep the base weight');
        assert.equal(recommendationWeight({ description: '具体描述'.repeat(25), category: '印度菜', per_person_cost: 50, favorite_count: 5 }, 0), 2.5);

        const synthetic = [4, 2, 2, 1, 1].map((weight, index) => ({ weight, place: { id: index + 1 }, distanceKm: 1 }));
        const counts = [0, 0, 0, 0, 0];
        for (let i = 0; i < 10000; i++) {
            const draw = drawRecommendation(synthetic, [], () => (i + 0.5) / 10000);
            counts[draw.place.id - 1]++;
        }
        assert.deepEqual(counts, [4000, 2000, 2000, 1000, 1000], 'selection follows W / sum(W)');
        assert.equal(drawRecommendation(synthetic, [], () => 0).place.id, 1);
        assert.equal(drawRecommendation(synthetic, [], () => 1 - Number.EPSILON).place.id, 5);
        assert.equal(drawRecommendation(synthetic, [1, 2], () => 0).place.id, 3);
        assert.equal(drawRecommendation(synthetic, [1, 2], () => 0).candidateCount, 5);
        assert.deepEqual(drawRecommendation(synthetic.slice(0, 4)), { place: null, candidateCount: 4, message: EMPTY_MESSAGE });
        assert.equal(drawRecommendation([]).message, EMPTY_MESSAGE);

        // Geographic coarse filtering must also work across the date line and near a pole.
        const datelineId = Number(insert.run('日期变更线附近', 0, -179.99, '其他').lastInsertRowid);
        assert.ok(nearbyCandidates(db._raw, { lat: 0, lng: 179.99 }).some(({ place }) => place.id === datelineId));
        const polarId = Number(insert.run('极点附近', 89.99, 120, '其他').lastInsertRowid);
        assert.ok(nearbyCandidates(db._raw, { lat: 89.99, lng: 0 }).some(({ place }) => place.id === polarId));

        assert.ok(vectorAvailable(), 'sqlite-vec is required for personalization integration tests');
        const unit = (axis, sign = 1) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => index === axis ? sign : 0);
        const putVector = (id, vector, current = true) => {
            db._raw.prepare('INSERT INTO place_vectors(place_id, embedding) VALUES (?, ?)')
                .run(BigInt(id), Buffer.from(new Float32Array(vector).buffer));
            db._raw.prepare('UPDATE Place SET has_vector = ? WHERE id = ?').run(current ? 1 : 0, id);
        };
        putVector(ids[0], unit(0));
        putVector(ids[1], unit(1));
        putVector(ids[2], unit(0, -1));
        putVector(ids[3], unit(0), false);
        const profile = {
            status: 'ready', model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS,
            algorithm_version: ALGORITHM_VERSION, source_place_count: 5, vector_place_count: 5, vector: unit(0)
        };
        const equalCandidates = ids.map((id) => ({ place: { id }, distanceKm: 1, weight: 1 }));
        const personalized = personalizeCandidates(db._raw, equalCandidates, profile);
        assert.equal(personalized.personalized, true);
        assert.ok(personalized.candidates[0].weight > personalized.candidates[1].weight * 5);
        assert.ok(personalized.candidates.every((candidate) => candidate.weight >= 0.2), 'every candidate retains its exploration probability');
        assert.equal(personalized.candidates[3].weight, personalized.candidates[4].weight, 'stale and missing vectors receive no preference boost');
        assert.ok(Math.abs(personalized.candidates.reduce((sum, c) => sum + c.weight, 0) - 5) < 1e-10);
        assert.ok(equalCandidates.every((candidate) => candidate.weight === 1), 'base weights must not be mutated');
        const sparsePreference = personalizeCandidates(db._raw, equalCandidates, { ...profile, vector_place_count: 1, source_place_count: 1 });
        const partialPreference = personalizeCandidates(db._raw, equalCandidates, { ...profile, source_place_count: 10 });
        assert.ok(sparsePreference.candidates[0].weight < personalized.candidates[0].weight);
        assert.ok(partialPreference.candidates[0].weight < personalized.candidates[0].weight);
        assert.equal(personalizeCandidates(db._raw, equalCandidates, { ...profile, model: 'different-model' }).personalized, false);
        assert.equal(personalizeCandidates(db._raw, equalCandidates, { ...profile, vector: unit(8) }).personalized, false);
        assert.equal(personalizeCandidates(db._raw, equalCandidates, { ...profile, vector: unit(0).fill(NaN) }).personalized, false);
        assert.equal(personalizeCandidates(db._raw, equalCandidates, null).personalized, false);
        const personalizedCounts = new Map(ids.map((id) => [id, 0]));
        const filteredPool = equalCandidates.filter((candidate) => ![ids[1], ids[2]].includes(candidate.place.id));
        const filteredWeights = personalizeCandidates(db._raw, filteredPool, profile).candidates;
        const filteredTotal = filteredWeights.reduce((sum, candidate) => sum + candidate.weight, 0);
        const expectedCounts = filteredWeights.map((candidate) => candidate.weight / filteredTotal * 3000);
        for (let index = 0; index < 3000; index += 1) {
            const drawn = drawRecommendation(equalCandidates, [ids[1], ids[2]], () => (index + 0.5) / 3000,
                (eligible) => personalizeCandidates(db._raw, eligible, profile));
            personalizedCounts.set(drawn.place.id, personalizedCounts.get(drawn.place.id) + 1);
        }
        filteredPool.forEach((candidate, index) => assert.ok(Math.abs(personalizedCounts.get(candidate.place.id) - expectedCounts[index]) <= 1,
            'personalization must mix after cooldown filtering'));
        assert.equal(personalizedCounts.get(ids[1]), 0);
        assert.equal(personalizedCounts.get(ids[2]), 0);
        assert.ok(personalizedCounts.get(ids[4]) > 0, 'missing vectors retain a chance to be recommended');

        const app = express();
        app.use('/places', placesRouter);
        server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
        const url = `http://127.0.0.1:${server.address().port}/places/random`;
        for (const query of ['', '?lat=&lng=0', '?lat=91&lng=0', '?lat=0&lng=NaN', '?lat=0&lat=1&lng=0', '?lat=0&lng=0&excludeIds=1,2,3']) {
            assert.equal((await fetch(url + query)).status, 400, query);
        }
        const response = await fetch(`${url}?lat=0&lng=0&excludeIds=${ids[0]},${ids[1]}`);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const body = await response.json();
        assert.equal(body.personalized, false);
        assert.equal(body.candidateCount, 5);
        assert.ok(ids.slice(2).includes(body.place.id));
        assert.ok(body.distanceKm <= 5);
        assert.equal(body.place.creator_name, '地点创建者', 'random place details must include the creator username');
        assert.equal(body.place.updated_by_name, '最后编辑者', 'the popup must receive the editor username instead of falling back to a UUID');
        assert.equal(body.place.updated_by, editorId, 'user IDs must still be available for permission checks');
        const token = (id) => jwt.sign({ id }, process.env.JWT_SECRET || 'yuyuko_secret_key', { expiresIn: 3600 });
        const authenticated = await fetch(`${url}?lat=0&lng=0`, { headers: { Authorization: `Bearer ${token('u0')}` } });
        const authenticatedBody = await authenticated.json();
        assert.equal(authenticated.status, 200);
        assert.equal(authenticatedBody.personalized, true, 'saved favorites must affect random recommendations');
        assert.equal(authenticatedBody.place.creator_name, '地点创建者');
        assert.equal(authenticatedBody.place.updated_by_name, '最后编辑者', 'personalized drawing must preserve display names');
        assert.equal('vector' in authenticatedBody, false);
        assert.equal('user_id' in authenticatedBody, false);
        db._raw.prepare('INSERT INTO User (id, username) VALUES (?, ?)').run('no-preferences', 'no-preferences');
        const spoofed = await (await fetch(`${url}?lat=0&lng=0&user_id=u0`, { headers: { Authorization: `Bearer ${token('no-preferences')}` } })).json();
        assert.equal(spoofed.personalized, false, 'request parameters cannot read another user profile');
        assert.equal((await (await fetch(`${url}?lat=0&lng=0&user_id=u0`)).json()).personalized, false);
        assert.equal((await fetch(`${url}?lat=0&lng=0`, { headers: { Authorization: 'Bearer invalid' } })).status, 401);
        const headers = { Authorization: `Bearer ${token('u0')}` };
        simulateMissingExtension = true;
        assert.equal((await (await fetch(`${url}?lat=0&lng=0`, { headers })).json()).personalized, false, 'no extension must fall back to ordinary discovery');
        simulateMissingExtension = false;
        // If a source vector becomes stale, the profile is rebuilt before drawing.
        db._raw.prepare('UPDATE Place SET has_vector = 0 WHERE id = ?').run(ids[0]);
        assert.equal((await (await fetch(`${url}?lat=0&lng=0`, { headers })).json()).personalized, false);
        assert.equal(getUserPreference('u0').status, 'pending');
        db._raw.prepare('UPDATE Place SET has_vector = 1 WHERE id = ?').run(ids[0]);
        assert.equal((await (await fetch(`${url}?lat=0&lng=0`, { headers })).json()).personalized, true);

        // Frontend requests must carry the acting token and preserve cancellation.
        const apiSource = fs.readFileSync(path.join(__dirname, '../../frontend/src/map/api.js'), 'utf8');
        const { fetchRandomPlace } = await import(`data:text/javascript;base64,${Buffer.from(apiSource).toString('base64')}`);
        const nativeFetch = global.fetch;
        let frontendRequest;
        try {
            global.fetch = async (...args) => { frontendRequest = args; return { ok: true, json: async () => body }; };
            const controller = new AbortController();
            await fetchRandomPlace('https://example.test', center, ids.slice(0, 3), { token: 'test-token', signal: controller.signal });
            assert.equal(frontendRequest[1].headers.Authorization, 'Bearer test-token');
            assert.equal(frontendRequest[1].signal, controller.signal);
            assert.equal(new URL(frontendRequest[0]).searchParams.get('excludeIds'), ids.slice(1, 3).join(','));
            await fetchRandomPlace('https://example.test', center);
            assert.equal(frontendRequest[1].headers, undefined, 'guest requests must not send an invalid token');
        } finally { global.fetch = nativeFetch; }
        // Missing user records must not remove an otherwise eligible restaurant.
        db._raw.prepare('DELETE FROM User WHERE id IN (?, ?)').run(creatorId, editorId);
        const orphaned = nearbyCandidates(db._raw, center);
        assert.equal(orphaned.length, 5);
        assert.ok(orphaned.every(({ place }) => place.creator_name === null && place.updated_by_name === null));
        db._raw.prepare('DELETE FROM Place WHERE id = ?').run(ids[4]);
        const sparse = await (await fetch(`${url}?lat=0&lng=0`)).json();
        assert.deepEqual(sparse, { place: null, candidateCount: 4, message: EMPTY_MESSAGE });
        console.log('Random recommendation: base/personalized distributions, exploration, profile refresh, authentication, 5km boundary, exclusions and frontend requests passed.');
    } finally {
        if (server) await new Promise((resolve) => server.close(resolve));
        db.close();
        redis.disconnect();
        // Only remove the known files created by this isolated test database.
        for (const suffix of ['', '-wal', '-shm']) {
            const file = databasePath + suffix;
            if (fs.existsSync(file)) fs.unlinkSync(file);
        }
        fs.rmdirSync(directory);
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
