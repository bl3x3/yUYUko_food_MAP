const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-random-'));
const databasePath = path.join(directory, 'test.sqlite');
process.env.DB_FILE = databasePath;
process.env.LOG_TO_FILE = 'false';
const { db, init } = require('../db');
const { recommendationWeight, nearbyCandidates, drawRecommendation, EMPTY_MESSAGE } = require('../services/randomRecommendation');
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
        assert.equal(body.candidateCount, 5);
        assert.ok(ids.slice(2).includes(body.place.id));
        assert.ok(body.distanceKm <= 5);
        db._raw.prepare('DELETE FROM Place WHERE id = ?').run(ids[4]);
        const sparse = await (await fetch(`${url}?lat=0&lng=0`)).json();
        assert.deepEqual(sparse, { place: null, candidateCount: 4, message: EMPTY_MESSAGE });
        console.log('Random recommendation: weights, distribution, 5km boundary, exclusions, sparse results and HTTP checks passed.');
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
