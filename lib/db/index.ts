import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.NEON_DATABASE_URL

export const pool = new Pool({
  ...(databaseUrl ? { connectionString: databaseUrl } : {}),
  connectionTimeoutMillis: 5000,
  max: 5,
})
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
      const client = await pool.connect()
      const runMigration = async (sql: string) => {
        try { return await client.query(sql) } catch (error) {
          const e = error as { code?: string; message?: string }
          console.error('[panel-schema:migration-error]', { code: e.code ?? 'UNKNOWN', message: e.message ?? 'migration failed', sql: sql.slice(0, 160) })
          throw error
        }
      }
      try {
        await runMigration('BEGIN')
        await runMigration(`CREATE TABLE IF NOT EXISTS "user" ("id" text PRIMARY KEY, "name" text NOT NULL, "email" text NOT NULL UNIQUE, "emailVerified" boolean NOT NULL DEFAULT false, "image" text, "role" text NOT NULL DEFAULT 'member', "approved" boolean NOT NULL DEFAULT false, "createdAt" timestamp NOT NULL DEFAULT now(), "updatedAt" timestamp NOT NULL DEFAULT now())`)
      await runMigration(`CREATE TABLE IF NOT EXISTS "nodes" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "userId" text NOT NULL, "name" text NOT NULL, "agentTokenHash" text NOT NULL UNIQUE, "status" text NOT NULL DEFAULT 'offline', "lastHeartbeat" timestamp, "cpuPercent" real NOT NULL DEFAULT 0, "memoryUsedMb" integer NOT NULL DEFAULT 0, "memoryTotalMb" integer NOT NULL DEFAULT 0, "diskUsedGb" real NOT NULL DEFAULT 0, "diskTotalGb" real NOT NULL DEFAULT 0, "createdAt" timestamp NOT NULL DEFAULT now(), "updatedAt" timestamp NOT NULL DEFAULT now())`)
      await runMigration(`CREATE TABLE IF NOT EXISTS "servers" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "userId" text NOT NULL, "nodeId" uuid NOT NULL, "name" text NOT NULL, "loader" text NOT NULL, "mcVersion" text NOT NULL, "loaderVersion" text, "memoryMb" integer NOT NULL DEFAULT 4096, "port" integer NOT NULL DEFAULT 25565, "status" text NOT NULL DEFAULT 'stopped', "installProgress" integer NOT NULL DEFAULT 0, "installError" text, "playerCount" integer NOT NULL DEFAULT 0, "pid" integer, "worldName" text NOT NULL DEFAULT 'world', "itemTrackingEnabled" boolean NOT NULL DEFAULT false, "javaArgs" text NOT NULL DEFAULT '', "createdAt" timestamp NOT NULL DEFAULT now(), "updatedAt" timestamp NOT NULL DEFAULT now())`)
      await runMigration(`CREATE TABLE IF NOT EXISTS "worlds" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "userId" text NOT NULL, "serverId" uuid NOT NULL, "name" text NOT NULL, "seed" text, "isActive" boolean NOT NULL DEFAULT false, "sizeMb" real NOT NULL DEFAULT 0, "lastBackupAt" timestamp, "createdAt" timestamp NOT NULL DEFAULT now())`)
      await runMigration(`CREATE TABLE IF NOT EXISTS "mods" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "userId" text NOT NULL, "serverId" uuid NOT NULL, "filename" text NOT NULL, "blobPathname" text NOT NULL, "sha256" text NOT NULL, "enabled" boolean NOT NULL DEFAULT true, "uploadedBy" text NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now())`)
      await runMigration(`CREATE TABLE IF NOT EXISTS "backups" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "userId" text NOT NULL, "worldId" uuid NOT NULL, "blobPathname" text NOT NULL, "sizeMb" real NOT NULL DEFAULT 0, "sizeBytes" bigint NOT NULL DEFAULT 0, "createdBy" text NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now())`)
      await runMigration(`CREATE TABLE IF NOT EXISTS "agent_commands" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "userId" text NOT NULL, "nodeId" uuid NOT NULL, "serverId" uuid, "type" text NOT NULL, "payload" jsonb NOT NULL DEFAULT '{}', "status" text NOT NULL DEFAULT 'queued', "result" jsonb, "createdAt" timestamp NOT NULL DEFAULT now(), "completedAt" timestamp)`)
      await runMigration(`CREATE TABLE IF NOT EXISTS "console_logs" ("id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "userId" text NOT NULL, "serverId" uuid NOT NULL, "stream" text NOT NULL DEFAULT 'stdout', "line" text NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now())`)
      await runMigration(`CREATE TABLE IF NOT EXISTS "audit_log" ("id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "userId" text NOT NULL, "action" text NOT NULL, "resourceType" text NOT NULL, "resourceId" text, "details" jsonb NOT NULL DEFAULT '{}', "createdAt" timestamp NOT NULL DEFAULT now())`)
      await runMigration(`CREATE INDEX IF NOT EXISTS "agent_commands_active_idx" ON "agent_commands" ("nodeId","serverId","status")`)
      await runMigration(`
        CREATE TABLE IF NOT EXISTS "server_permissions" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "userId" text NOT NULL,
          "ownerUserId" text NOT NULL,
          "serverId" uuid NOT NULL,
          "canStart" boolean NOT NULL DEFAULT false,
          "canStop" boolean NOT NULL DEFAULT false,
          "canRestart" boolean NOT NULL DEFAULT false,
          "canConsole" boolean NOT NULL DEFAULT false,
          "canFiles" boolean NOT NULL DEFAULT false,
          "canBackup" boolean NOT NULL DEFAULT false,
          "canReset" boolean NOT NULL DEFAULT false,
          "canViewLostItems" boolean NOT NULL DEFAULT false,
          "canManageLostItems" boolean NOT NULL DEFAULT false,
          "sections" jsonb NOT NULL DEFAULT '[]'::jsonb,
          "createdAt" timestamp NOT NULL DEFAULT now(),
          CONSTRAINT "server_permissions_user_server_unique" UNIQUE ("userId", "serverId")
        )
      `)
      await runMigration(`ALTER TABLE "server_permissions" ADD COLUMN IF NOT EXISTS "sections" jsonb NOT NULL DEFAULT '[]'::jsonb`)
      await runMigration(`ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "issuer" text`)
      await runMigration(`
        CREATE TABLE IF NOT EXISTS "server_sftp" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "serverId" uuid NOT NULL UNIQUE,
          "nodeId" uuid NOT NULL,
          "username" text NOT NULL,
          "passwordHash" text NOT NULL,
          "port" integer NOT NULL DEFAULT 22,
          "rootPath" text NOT NULL,
          "status" text NOT NULL DEFAULT 'queued',
          "lastError" text,
          "lastTestAt" timestamp,
          "passwordRotatedAt" timestamp,
          "disabledAt" timestamp,
          "createdAt" timestamp NOT NULL DEFAULT now(),
          "updatedAt" timestamp NOT NULL DEFAULT now()
        )
      `)
      await runMigration(`
        CREATE TABLE IF NOT EXISTS "server_schedules" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "userId" text NOT NULL,
          "serverId" uuid NOT NULL,
          "name" text NOT NULL,
          "taskType" text NOT NULL,
          "cadence" text NOT NULL DEFAULT 'daily',
          "timeOfDay" text,
          "weekday" integer,
          "intervalMinutes" integer,
          "timezoneOffsetMinutes" integer NOT NULL DEFAULT 0,
          "enabled" boolean NOT NULL DEFAULT true,
          "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
          "lastRunAt" timestamp,
          "nextRunAt" timestamp NOT NULL,
          "createdAt" timestamp NOT NULL DEFAULT now(),
          "updatedAt" timestamp NOT NULL DEFAULT now()
        )
      `)
      await runMigration(`ALTER TABLE "server_schedules" ADD COLUMN IF NOT EXISTS "name" text NOT NULL DEFAULT 'Unnamed schedule', ADD COLUMN IF NOT EXISTS "taskType" text NOT NULL DEFAULT 'restart', ADD COLUMN IF NOT EXISTS "cadence" text NOT NULL DEFAULT 'daily', ADD COLUMN IF NOT EXISTS "timeOfDay" text, ADD COLUMN IF NOT EXISTS "weekday" integer, ADD COLUMN IF NOT EXISTS "intervalMinutes" integer, ADD COLUMN IF NOT EXISTS "timezoneOffsetMinutes" integer NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS "enabled" boolean NOT NULL DEFAULT true, ADD COLUMN IF NOT EXISTS "payload" jsonb NOT NULL DEFAULT '{}'::jsonb, ADD COLUMN IF NOT EXISTS "lastRunAt" timestamp, ADD COLUMN IF NOT EXISTS "nextRunAt" timestamp NOT NULL DEFAULT now(), ADD COLUMN IF NOT EXISTS "createdAt" timestamp NOT NULL DEFAULT now(), ADD COLUMN IF NOT EXISTS "updatedAt" timestamp NOT NULL DEFAULT now()`)
      await runMigration(`ALTER TABLE "managed_databases" ADD COLUMN IF NOT EXISTS "userId" text NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS "serverId" uuid, ADD COLUMN IF NOT EXISTS "nodeId" uuid, ADD COLUMN IF NOT EXISTS "engine" text NOT NULL DEFAULT 'mariadb', ADD COLUMN IF NOT EXISTS "databaseName" text NOT NULL DEFAULT 'minecraft', ADD COLUMN IF NOT EXISTS "databaseUser" text NOT NULL DEFAULT 'minecraft', ADD COLUMN IF NOT EXISTS "host" text NOT NULL DEFAULT '127.0.0.1', ADD COLUMN IF NOT EXISTS "port" integer NOT NULL DEFAULT 3306, ADD COLUMN IF NOT EXISTS "credentialsPath" text, ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'queued', ADD COLUMN IF NOT EXISTS "lastError" text, ADD COLUMN IF NOT EXISTS "createdAt" timestamp NOT NULL DEFAULT now(), ADD COLUMN IF NOT EXISTS "updatedAt" timestamp NOT NULL DEFAULT now()`)
      await runMigration(`ALTER TABLE "server_sftp" ADD COLUMN IF NOT EXISTS "serverId" uuid, ADD COLUMN IF NOT EXISTS "nodeId" uuid, ADD COLUMN IF NOT EXISTS "username" text NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS "passwordHash" text NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS "port" integer NOT NULL DEFAULT 22, ADD COLUMN IF NOT EXISTS "rootPath" text NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'queued', ADD COLUMN IF NOT EXISTS "lastError" text, ADD COLUMN IF NOT EXISTS "lastTestAt" timestamp, ADD COLUMN IF NOT EXISTS "passwordRotatedAt" timestamp, ADD COLUMN IF NOT EXISTS "disabledAt" timestamp, ADD COLUMN IF NOT EXISTS "createdAt" timestamp NOT NULL DEFAULT now(), ADD COLUMN IF NOT EXISTS "updatedAt" timestamp NOT NULL DEFAULT now()`)
      await runMigration(`ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS "lastHeartbeat" timestamp, ADD COLUMN IF NOT EXISTS "cpuPercent" real NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS "memoryUsedMb" integer NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS "memoryTotalMb" integer NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS "diskUsedGb" real NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS "diskTotalGb" real NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS "updatedAt" timestamp NOT NULL DEFAULT now()`)
      await runMigration(`ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "installProgress" integer NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS "installError" text, ADD COLUMN IF NOT EXISTS "playerCount" integer NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS "pid" integer, ADD COLUMN IF NOT EXISTS "worldName" text NOT NULL DEFAULT 'world', ADD COLUMN IF NOT EXISTS "itemTrackingEnabled" boolean NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS "javaArgs" text NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS "updatedAt" timestamp NOT NULL DEFAULT now()`)
      await runMigration(`ALTER TABLE "agent_commands" ADD COLUMN IF NOT EXISTS "result" jsonb, ADD COLUMN IF NOT EXISTS "completedAt" timestamp`)
      await runMigration(`CREATE INDEX IF NOT EXISTS "server_schedules_due_idx" ON "server_schedules" ("enabled","nextRunAt")`)
      await runMigration(`CREATE INDEX IF NOT EXISTS "server_schedules_server_idx" ON "server_schedules" ("serverId")`)
      await runMigration(`
        CREATE TABLE IF NOT EXISTS "managed_databases" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "userId" text NOT NULL,
          "serverId" uuid NOT NULL,
          "nodeId" uuid NOT NULL,
          "engine" text NOT NULL DEFAULT 'mariadb',
          "databaseName" text NOT NULL,
          "databaseUser" text NOT NULL,
          "host" text NOT NULL DEFAULT '127.0.0.1',
          "port" integer NOT NULL DEFAULT 3306,
          "credentialsPath" text,
          "status" text NOT NULL DEFAULT 'queued',
          "lastError" text,
          "createdAt" timestamp NOT NULL DEFAULT now(),
          "updatedAt" timestamp NOT NULL DEFAULT now()
        )
      `)
      await runMigration(`CREATE UNIQUE INDEX IF NOT EXISTS "managed_databases_name_idx" ON "managed_databases" ("serverId","databaseName")`)
      await runMigration(`CREATE UNIQUE INDEX IF NOT EXISTS "managed_databases_user_idx" ON "managed_databases" ("serverId","databaseUser")`)
      await runMigration(`
        CREATE TABLE IF NOT EXISTS "server_settings" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "serverId" uuid NOT NULL UNIQUE,
          "userId" text NOT NULL,
          "settings" jsonb NOT NULL DEFAULT '{}'::jsonb,
          "capabilities" jsonb NOT NULL DEFAULT '[]'::jsonb,
          "updatedBy" text NOT NULL,
          "createdAt" timestamp NOT NULL DEFAULT now(),
          "updatedAt" timestamp NOT NULL DEFAULT now()
        )
      `)
      await runMigration(`CREATE UNIQUE INDEX IF NOT EXISTS "server_settings_server_idx" ON "server_settings" ("serverId")`)
      await runMigration(`CREATE TABLE IF NOT EXISTS "operation_logs" ("id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "userId" text NOT NULL, "serverId" uuid NOT NULL, "operation" text NOT NULL, "status" text NOT NULL, "message" text, "createdAt" timestamp NOT NULL DEFAULT now())`)
      await runMigration(`CREATE TABLE IF NOT EXISTS "lost_items" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "userId" text NOT NULL, "serverId" uuid NOT NULL, "eventId" text NOT NULL UNIQUE, "playerUuid" text, "playerName" text, "itemId" text NOT NULL, "itemName" text NOT NULL, "amount" integer NOT NULL, "reason" text NOT NULL, "world" text NOT NULL, "x" integer NOT NULL, "y" integer NOT NULL, "z" integer NOT NULL, "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb, "occurredAt" timestamp NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now())`)
      await runMigration(`ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'offline', ADD COLUMN IF NOT EXISTS "lastHeartbeat" timestamp, ADD COLUMN IF NOT EXISTS "updatedAt" timestamp NOT NULL DEFAULT now()`)
      await runMigration(`ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "installError" text, ADD COLUMN IF NOT EXISTS "installProgress" integer NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS "itemTrackingEnabled" boolean NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS "updatedAt" timestamp NOT NULL DEFAULT now()`)
      await runMigration(`ALTER TABLE "worlds" ADD COLUMN IF NOT EXISTS "lastBackupAt" timestamp`)
      await runMigration(`ALTER TABLE "agent_commands" ADD COLUMN IF NOT EXISTS "completedAt" timestamp, ADD COLUMN IF NOT EXISTS "result" jsonb`)
      await runMigration(`ALTER TABLE "console_logs" ADD COLUMN IF NOT EXISTS "stream" text NOT NULL DEFAULT 'stdout'`)
      await runMigration(`
        CREATE TABLE IF NOT EXISTS "upload_sessions" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "uploadId" uuid NOT NULL UNIQUE,
          "commandId" uuid NOT NULL,
          "userId" text NOT NULL,
          "serverId" uuid NOT NULL,
          "nodeId" uuid NOT NULL,
          "filename" text NOT NULL,
          "totalSize" bigint NOT NULL,
          "chunkSize" integer NOT NULL,
          "totalParts" integer NOT NULL,
          "receivedParts" jsonb NOT NULL DEFAULT '[]'::jsonb,
          "receivedBytes" bigint NOT NULL DEFAULT 0,
          "status" text NOT NULL DEFAULT 'starting',
          "createdAt" timestamp NOT NULL DEFAULT now(),
          "lastActivityAt" timestamp NOT NULL DEFAULT now(),
          "completedAt" timestamp,
          "error" text
        )
      `)
      await runMigration(`ALTER TABLE "upload_sessions" ADD COLUMN IF NOT EXISTS "error" text`)
      await runMigration(`CREATE INDEX IF NOT EXISTS "upload_sessions_activity_idx" ON "upload_sessions" ("nodeId","status","lastActivityAt")`)
      await runMigration(`
        CREATE TABLE IF NOT EXISTS "server_security" (
          "serverId" uuid PRIMARY KEY,
          "userId" text NOT NULL,
          "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
          "lastSnapshot" jsonb,
          "lastScanAt" timestamp,
          "lastScanStatus" text,
          "createdAt" timestamp NOT NULL DEFAULT now(),
          "updatedAt" timestamp NOT NULL DEFAULT now()
        )
      `)
      await runMigration(`CREATE INDEX IF NOT EXISTS "server_security_scan_idx" ON "server_security" ("lastScanAt")`)
      await runMigration(`
        CREATE TABLE IF NOT EXISTS "security_ip_rules" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "serverId" uuid NOT NULL,
          "userId" text NOT NULL,
          "ruleType" text NOT NULL,
          "cidr" text NOT NULL,
          "description" text NOT NULL DEFAULT '',
          "source" text NOT NULL DEFAULT 'manual',
          "expiresAt" timestamp,
          "createdBy" text NOT NULL,
          "createdAt" timestamp NOT NULL DEFAULT now()
        )
      `)
      await runMigration(`CREATE UNIQUE INDEX IF NOT EXISTS "security_ip_rules_unique_idx" ON "security_ip_rules" ("serverId","ruleType","cidr")`)
      await runMigration(`CREATE INDEX IF NOT EXISTS "security_ip_rules_server_idx" ON "security_ip_rules" ("serverId","expiresAt")`)
      await runMigration(`
        CREATE TABLE IF NOT EXISTS "security_events" (
          "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          "userId" text NOT NULL,
          "serverId" uuid NOT NULL,
          "severity" text NOT NULL DEFAULT 'info',
          "source" text NOT NULL DEFAULT 'security',
          "event" text NOT NULL,
          "status" text NOT NULL DEFAULT 'open',
          "ip" text,
          "player" text,
          "actorName" text,
          "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
          "createdAt" timestamp NOT NULL DEFAULT now()
        )
      `)
      await runMigration(`CREATE INDEX IF NOT EXISTS "security_events_server_time_idx" ON "security_events" ("serverId","createdAt" DESC)`)
      await runMigration(`
        CREATE TABLE IF NOT EXISTS "support_consents" (
          "userId" text PRIMARY KEY,
          "version" text NOT NULL,
          "acceptedAt" timestamp NOT NULL DEFAULT now()
        )
      `)
      await runMigration(`
        CREATE TABLE IF NOT EXISTS "support_threads" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "type" text NOT NULL,
          "status" text NOT NULL DEFAULT 'pending',
          "subject" text NOT NULL,
          "priority" text NOT NULL DEFAULT 'normal',
          "creatorUserId" text NOT NULL,
          "targetUserId" text,
          "assignedUserId" text,
          "createdByRole" text NOT NULL DEFAULT 'member',
          "acceptedAt" timestamp,
          "closedAt" timestamp,
          "closedBy" text,
          "lastMessageAt" timestamp NOT NULL DEFAULT now(),
          "createdAt" timestamp NOT NULL DEFAULT now(),
          "updatedAt" timestamp NOT NULL DEFAULT now()
        )
      `)
      await runMigration(`CREATE INDEX IF NOT EXISTS "support_threads_activity_idx" ON "support_threads" ("lastMessageAt" DESC)`)
      await runMigration(`CREATE INDEX IF NOT EXISTS "support_threads_creator_idx" ON "support_threads" ("creatorUserId","lastMessageAt" DESC)`)
      await runMigration(`CREATE INDEX IF NOT EXISTS "support_threads_target_idx" ON "support_threads" ("targetUserId","lastMessageAt" DESC)`)
      await runMigration(`CREATE INDEX IF NOT EXISTS "support_threads_assigned_idx" ON "support_threads" ("assignedUserId","status")`)
      await runMigration(`
        CREATE TABLE IF NOT EXISTS "support_messages" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "threadId" uuid NOT NULL,
          "senderUserId" text NOT NULL,
          "body" text NOT NULL DEFAULT '',
          "createdAt" timestamp NOT NULL DEFAULT now()
        )
      `)
      await runMigration(`CREATE INDEX IF NOT EXISTS "support_messages_thread_idx" ON "support_messages" ("threadId","createdAt")`)
      await runMigration(`
        CREATE TABLE IF NOT EXISTS "support_attachments" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "threadId" uuid NOT NULL,
          "messageId" uuid NOT NULL,
          "uploaderUserId" text NOT NULL,
          "pathname" text NOT NULL,
          "url" text NOT NULL DEFAULT '',
          "filename" text NOT NULL,
          "contentType" text NOT NULL,
          "sizeBytes" bigint NOT NULL DEFAULT 0,
          "createdAt" timestamp NOT NULL DEFAULT now()
        )
      `)
      await runMigration(`CREATE INDEX IF NOT EXISTS "support_attachments_message_idx" ON "support_attachments" ("messageId")`)
      await runMigration(`CREATE INDEX IF NOT EXISTS "support_attachments_thread_idx" ON "support_attachments" ("threadId","createdAt")`)
      await runMigration('COMMIT')
      } catch (error) {
        await runMigration('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    })().catch(error => {
      panelSchemaReady = null
      throw error
    })
  }
  return panelSchemaReady
}
