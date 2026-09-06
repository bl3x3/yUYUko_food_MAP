const { haversineDistanceKm, placeDetailCompleteness } = require('./semanticSearch');

const RADIUS_KM = 5;
const MIN_CANDIDATES = 5;
const EMPTY_MESSAGE = '附近好像没有结果，换个地方试试吧';

function recommendationWeight(place, distanceKm) {
    const completeness = placeDetailCompleteness(place);
    const favorites = Math.max(0, Number(place.favorite_count) || 0);
    return 1 + 1 / (1 + distanceKm / 2)
        + 0.3 * completeness + 0.4 * favorites / (favorites + 5);
}

function nearbyCandidates(database, center) {
    // A spherical bounding box first, then exact great-circle distance. At the
    // poles or across the date line, latitude alone is a safe coarse filter.
    const angularRadius = RADIUS_KM / 6371.0088;
    const latDelta = angularRadius * 180 / Math.PI;
    const minLat = Math.max(-90, center.lat - latDelta);
    const maxLat = Math.min(90, center.lat + latDelta);
    const params = [minLat, maxLat];
    let longitudeFilter = '';
    if (minLat > -90 && maxLat < 90) {
        const lngDelta = Math.asin(Math.min(1, Math.sin(angularRadius)
            / Math.cos(center.lat * Math.PI / 180))) * 180 / Math.PI;
        if (center.lng - lngDelta >= -180 && center.lng + lngDelta <= 180) {
            longitudeFilter = ' AND p.longitude BETWEEN ? AND ?';
            params.push(center.lng - lngDelta, center.lng + lngDelta);
        }
    }
    const rows = database.prepare(`SELECT p.*,
        (SELECT COUNT(DISTINCT f.user_id) FROM Favorite f WHERE f.place_id = p.id) AS favorite_count
        FROM Place p WHERE p.latitude BETWEEN ? AND ?${longitudeFilter}
        AND instr(COALESCE(p.category, ''), '避雷') = 0`).all(...params);
    return rows.flatMap((place) => {
        const distanceKm = haversineDistanceKm(center, { lat: place.latitude, lng: place.longitude });
        if (distanceKm === null || distanceKm > RADIUS_KM) return [];
        return [{ place, distanceKm, weight: recommendationWeight(place, distanceKm) }];
    });
}

function drawRecommendation(candidates, excludedIds = [], random = Math.random) {
    // The minimum is checked BEFORE applying the short-term repeat cooldown.
    if (candidates.length < MIN_CANDIDATES) {
        return { place: null, candidateCount: candidates.length, message: EMPTY_MESSAGE };
    }
    const excluded = new Set(excludedIds.slice(-2));
    const eligible = candidates.filter(({ place }) => !excluded.has(place.id));
    const total = eligible.reduce((sum, candidate) => sum + candidate.weight, 0);
    let ticket = random() * total;
    let selected = eligible[eligible.length - 1];
    for (const candidate of eligible) {
        ticket -= candidate.weight;
        if (ticket < 0) {
            selected = candidate;
            break;
        }
    }
    return { place: selected.place, distanceKm: selected.distanceKm, candidateCount: candidates.length };
}

module.exports = { recommendationWeight, nearbyCandidates, drawRecommendation, EMPTY_MESSAGE };
