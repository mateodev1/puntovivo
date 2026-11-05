import type Database from 'better-sqlite3';
import { seedDefaultData } from '../../db/seed.js';
import type { DatabaseInstance } from '../../db/index.js';

/**
 * Seed default rows into a database pinned to an older migration prefix.
 *
 * `seedDefaultData` inserts through the current Drizzle schema, which names
 * columns added by later migrations (`users.pin_failed_attempts`). Upgrade
 * tests deliberately boot a historical schema, so the column is added only for
 * the duration of the seed and dropped again to keep the schema historical.
 */
export async function seedHistoricalDefaults(db: DatabaseInstance): Promise<void> {
  const sqlite = (db as unknown as { $client: Database.Database }).$client;
  sqlite.exec('ALTER TABLE users ADD COLUMN pin_failed_attempts integer DEFAULT 0 NOT NULL');
  try {
    await seedDefaultData(db);
  } finally {
    sqlite.exec('ALTER TABLE users DROP COLUMN pin_failed_attempts');
  }
}
