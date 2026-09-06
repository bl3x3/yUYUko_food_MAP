// Best-effort authenticated telemetry: never delay opening a map app or a share sheet.
export function recordPlaceBehavior(backendUrl, token, placeId, eventType, channel) {
    if (!backendUrl || !token || !/^[1-9]\d*$/.test(String(placeId)) || !Number.isSafeInteger(Number(placeId))) {
        return Promise.resolve(false);
    }
    try {
        const eventId = globalThis.crypto?.randomUUID?.()
            || `event_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        return fetch(`${backendUrl}/api/preferences/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ event_id: eventId, place_id: Number(placeId), event_type: eventType, channel }),
            keepalive: true
        }).then((response) => response.ok).catch(() => false);
    } catch (_) {
        return Promise.resolve(false);
    }
}

// A resolved native share means handoff to the OS/app, not delivery to a recipient.
export async function sharePlaceContent({ data, nativeShare, copy, record, channel }) {
    if (nativeShare) {
        try {
            await nativeShare(data);
            record('share', channel);
            return 'shared';
        } catch (_) {
            return 'cancelled_or_failed';
        }
    }
    return copyPlaceContent({ text: data.url, copy, record, channel });
}

export async function copyPlaceContent({ text, copy, record, channel }) {
    try {
        if (!await copy(text)) return 'failed';
        record('share_copy', channel);
        return 'copied';
    } catch (_) {
        return 'failed';
    }
}
