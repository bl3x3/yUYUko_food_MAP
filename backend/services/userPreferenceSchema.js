// Called after the existing User/Place/Favorite migrations have completed.
function initUserPreferenceSchema(rawDb) {
    rawDb.exec(`
        CREATE TABLE IF NOT EXISTS UserBehaviorEvent (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
            place_id INTEGER NOT NULL REFERENCES Place(id) ON DELETE CASCADE,
            event_id TEXT NOT NULL,
            event_type TEXT NOT NULL CHECK(event_type IN ('favorite_add', 'favorite_remove', 'navigation', 'share', 'share_copy')),
            channel TEXT NOT NULL,
            occurred_at INTEGER NOT NULL,
            contributes INTEGER NOT NULL DEFAULT 1 CHECK(contributes IN (0, 1)),
            UNIQUE(user_id, event_id)
        );
        CREATE INDEX IF NOT EXISTS idx_behavior_user_time ON UserBehaviorEvent(user_id, occurred_at);
        CREATE INDEX IF NOT EXISTS idx_behavior_dedupe ON UserBehaviorEvent(user_id, place_id, event_type, occurred_at);
        CREATE INDEX IF NOT EXISTS idx_behavior_place_user ON UserBehaviorEvent(place_id, user_id);

        CREATE TABLE IF NOT EXISTS UserPreference (
            user_id TEXT PRIMARY KEY REFERENCES User(id) ON DELETE CASCADE,
            vector BLOB,
            model TEXT,
            dimensions INTEGER,
            algorithm_version INTEGER,
            status TEXT NOT NULL DEFAULT 'pending',
            source_place_count INTEGER NOT NULL DEFAULT 0,
            vector_place_count INTEGER NOT NULL DEFAULT 0,
            total_weight REAL NOT NULL DEFAULT 0,
            updated_at INTEGER,
            dirty INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_preference_refresh ON UserPreference(dirty, updated_at);

        CREATE TRIGGER IF NOT EXISTS preference_favorite_added AFTER INSERT ON Favorite BEGIN
            INSERT INTO UserPreference(user_id, dirty)
                SELECT id, 1 FROM User WHERE id = NEW.user_id
                ON CONFLICT(user_id) DO UPDATE SET dirty = 1;
        END;
        CREATE TRIGGER IF NOT EXISTS preference_favorite_removed AFTER DELETE ON Favorite BEGIN
            UPDATE UserPreference SET dirty = 1 WHERE user_id = OLD.user_id;
        END;
        CREATE TRIGGER IF NOT EXISTS preference_behavior_added AFTER INSERT ON UserBehaviorEvent WHEN NEW.contributes = 1 BEGIN
            INSERT INTO UserPreference(user_id, dirty) VALUES(NEW.user_id, 1)
                ON CONFLICT(user_id) DO UPDATE SET dirty = 1;
        END;
        CREATE TRIGGER IF NOT EXISTS preference_behavior_removed AFTER DELETE ON UserBehaviorEvent BEGIN
            UPDATE UserPreference SET dirty = 1 WHERE user_id = OLD.user_id;
        END;
        CREATE TRIGGER IF NOT EXISTS preference_place_changed
        AFTER UPDATE OF has_vector, vector_updated_at, name, category, description, per_person_cost ON Place BEGIN
            UPDATE UserPreference SET dirty = 1 WHERE user_id IN (
                SELECT user_id FROM Favorite WHERE place_id = NEW.id
                UNION SELECT user_id FROM UserBehaviorEvent WHERE place_id = NEW.id
            );
        END;
        CREATE TRIGGER IF NOT EXISTS preference_place_deleted BEFORE DELETE ON Place BEGIN
            UPDATE UserPreference SET dirty = 1 WHERE user_id IN (
                SELECT user_id FROM Favorite WHERE place_id = OLD.id
                UNION SELECT user_id FROM UserBehaviorEvent WHERE place_id = OLD.id
            );
        END;
    `);
    // Existing favorites are a current-state baseline, not invented historical events.
    rawDb.exec(`INSERT OR IGNORE INTO UserPreference(user_id)
                SELECT DISTINCT f.user_id FROM Favorite f JOIN User u ON u.id = f.user_id`);
}

module.exports = { initUserPreferenceSchema };
