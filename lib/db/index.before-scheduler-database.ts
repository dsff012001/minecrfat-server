import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

export const pool = new Pool({ connectionString: process.env.DATABASE_URL })
export const db = drizzle(pool, { schema })

let panelSchemaReady: Promise<void> | null = null

/**
 * Lightweight compatibility migration for deployments that already have the
 * BlockCtrl database. It is intentionally idempotent so old installations can
 * be upgraded without manually running SQL first.
 */
export function ensurePanelSchema() {
  if (!panelSchemaReady) {
    panelSchemaReady = (async () => {
      await pool.query(`ALTER TABLE "server_permissions" ADD COLUMN IF NOT EXISTS "sections" jsonb NOT NULL DEFAULT '[]'::jsonb`)
      await pool.query(`ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "issuer" text`)
    })().catch(error => {
      panelSchemaReady = null
      throw error
    })
  }
  return panelSchemaReady
}
