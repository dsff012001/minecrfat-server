import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { pool } from '@/lib/db'

export type IntegrationKind = 'discord' | 'discord-bot' | 'web-api' | 'live-stream'
export type IntegrationEventKey =
  | 'player_join'
  | 'player_leave'
  | 'server_start'
  | 'server_stop'
  | 'server_restart'
  | 'server_crash'
  | 'player_death'
  | 'player_advancement'
  | 'player_ban'
  | 'player_unban'
  | 'whitelist_add'
  | 'whitelist_remove'

export type IntegrationRow = {
  id: string
  serverId: string
  kind: IntegrationKind
  enabled: boolean
  status: string
  config: Record<string, unknown>
  secretCiphertext: string | null
  secretIv: string | null
  secretTag: string | null
  updatedBy: string
  lastTestAt: Date | null
  lastError: string | null
  createdAt: Date
  updatedAt: Date
}

let schemaReady: Promise<void> | null = null

export function ensureIntegrationSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS server_integrations (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "serverId" uuid NOT NULL,
          kind text NOT NULL,
          enabled boolean NOT NULL DEFAULT false,
          status text NOT NULL DEFAULT 'not_configured',
          config jsonb NOT NULL DEFAULT '{}'::jsonb,
          "secretCiphertext" text,
          "secretIv" text,
          "secretTag" text,
          "updatedBy" text NOT NULL,
          "lastTestAt" timestamp,
          "lastError" text,
          "createdAt" timestamp NOT NULL DEFAULT now(),
          "updatedAt" timestamp NOT NULL DEFAULT now(),
          CONSTRAINT server_integrations_server_kind_unique UNIQUE ("serverId", kind)
        )
      `)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS integration_logs (
          id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          "serverId" uuid NOT NULL,
          integration text NOT NULL,
          level text NOT NULL DEFAULT 'info',
          event text NOT NULL,
          details jsonb NOT NULL DEFAULT '{}'::jsonb,
          "createdAt" timestamp NOT NULL DEFAULT now()
        )
      `)
      await pool.query('CREATE INDEX IF NOT EXISTS integration_logs_server_created_idx ON integration_logs ("serverId", "createdAt" DESC)')
      await pool.query(`
        CREATE TABLE IF NOT EXISTS integration_oauth_states (
          state text PRIMARY KEY,
          "serverId" uuid NOT NULL,
          "userId" text NOT NULL,
          platform text NOT NULL,
          "codeVerifier" text,
          "createdAt" timestamp NOT NULL DEFAULT now(),
          "expiresAt" timestamp NOT NULL
        )
      `)
      await pool.query('CREATE INDEX IF NOT EXISTS integration_oauth_states_expiry_idx ON integration_oauth_states ("expiresAt")')
    })()
  }
  return schemaReady
}

function encryptionKey() {
  const raw = process.env.INTEGRATION_ENCRYPTION_KEY?.trim()
  if (!raw) return null
  return createHash('sha256').update(raw).digest()
}

export function integrationEncryptionReady() {
  return !!encryptionKey()
}

export function encryptIntegrationSecret(secret: Record<string, string>) {
  const key = encryptionKey()
  if (!key) throw new Error('INTEGRATION_ENCRYPTION_KEY yapılandırılmadan gizli entegrasyon bilgileri kaydedilemez.')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify(secret), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    secretCiphertext: ciphertext.toString('base64url'),
    secretIv: iv.toString('base64url'),
    secretTag: tag.toString('base64url'),
  }
}

export function decryptIntegrationSecret(row: Pick<IntegrationRow, 'secretCiphertext' | 'secretIv' | 'secretTag'>) {
  if (!row.secretCiphertext || !row.secretIv || !row.secretTag) return null
  const key = encryptionKey()
  if (!key) throw new Error('INTEGRATION_ENCRYPTION_KEY yapılandırılmamış.')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.secretIv, 'base64url'))
  decipher.setAuthTag(Buffer.from(row.secretTag, 'base64url'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(row.secretCiphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
  const parsed = JSON.parse(plaintext) as Record<string, unknown>
  return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string')) as Record<string, string>
}

function rowFromDb(row: Record<string, unknown>): IntegrationRow {
  return {
    id: String(row.id),
    serverId: String(row.serverId),
    kind: String(row.kind) as IntegrationKind,
    enabled: row.enabled === true,
    status: String(row.status ?? 'not_configured'),
    config: row.config && typeof row.config === 'object' ? row.config as Record<string, unknown> : {},
    secretCiphertext: row.secretCiphertext ? String(row.secretCiphertext) : null,
    secretIv: row.secretIv ? String(row.secretIv) : null,
    secretTag: row.secretTag ? String(row.secretTag) : null,
    updatedBy: String(row.updatedBy ?? ''),
    lastTestAt: row.lastTestAt ? new Date(String(row.lastTestAt)) : null,
    lastError: row.lastError ? String(row.lastError) : null,
    createdAt: new Date(String(row.createdAt)),
    updatedAt: new Date(String(row.updatedAt)),
  }
}

export async function getIntegration(serverId: string, kind: IntegrationKind) {
  await ensureIntegrationSchema()
  const result = await pool.query('SELECT * FROM server_integrations WHERE "serverId"=$1 AND kind=$2 LIMIT 1', [serverId, kind])
  return result.rows[0] ? rowFromDb(result.rows[0]) : null
}

export async function listIntegrations(serverId: string) {
  await ensureIntegrationSchema()
  const result = await pool.query('SELECT * FROM server_integrations WHERE "serverId"=$1 ORDER BY kind', [serverId])
  return result.rows.map(rowFromDb)
}

export async function upsertIntegration(input: {
  serverId: string
  kind: IntegrationKind
  userId: string
  enabled?: boolean
  status?: string
  config?: Record<string, unknown>
  secret?: Record<string, string> | null
  preserveSecret?: boolean
  lastTestAt?: Date | null
  lastError?: string | null
}) {
  await ensureIntegrationSchema()
  const existing = await getIntegration(input.serverId, input.kind)
  let secretCiphertext = existing?.secretCiphertext ?? null
  let secretIv = existing?.secretIv ?? null
  let secretTag = existing?.secretTag ?? null
  if (input.secret) {
    const encrypted = encryptIntegrationSecret(input.secret)
    secretCiphertext = encrypted.secretCiphertext
    secretIv = encrypted.secretIv
    secretTag = encrypted.secretTag
  } else if (input.secret === null && !input.preserveSecret) {
    secretCiphertext = null
    secretIv = null
    secretTag = null
  }
  const config = input.config ?? existing?.config ?? {}
  const enabled = input.enabled ?? existing?.enabled ?? false
  const status = input.status ?? existing?.status ?? 'not_configured'
  const lastTestAt = input.lastTestAt === undefined ? existing?.lastTestAt ?? null : input.lastTestAt
  const lastError = input.lastError === undefined ? existing?.lastError ?? null : input.lastError
  const result = await pool.query(
    `INSERT INTO server_integrations ("serverId",kind,enabled,status,config,"secretCiphertext","secretIv","secretTag","updatedBy","lastTestAt","lastError")
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)
     ON CONFLICT ("serverId",kind) DO UPDATE SET
       enabled=EXCLUDED.enabled,status=EXCLUDED.status,config=EXCLUDED.config,
       "secretCiphertext"=EXCLUDED."secretCiphertext","secretIv"=EXCLUDED."secretIv","secretTag"=EXCLUDED."secretTag",
       "updatedBy"=EXCLUDED."updatedBy","lastTestAt"=EXCLUDED."lastTestAt","lastError"=EXCLUDED."lastError","updatedAt"=now()
     RETURNING *`,
    [input.serverId, input.kind, enabled, status, JSON.stringify(config), secretCiphertext, secretIv, secretTag, input.userId, lastTestAt, lastError],
  )
  return rowFromDb(result.rows[0])
}

export async function writeIntegrationLog(serverId: string, integration: string, event: string, details: Record<string, unknown> = {}, level = 'info') {
  await ensureIntegrationSchema()
  await pool.query(
    'INSERT INTO integration_logs ("serverId",integration,level,event,details) VALUES ($1,$2,$3,$4,$5::jsonb)',
    [serverId, integration.slice(0, 80), level.slice(0, 20), event.slice(0, 120), JSON.stringify(details)],
  )
}

export async function listIntegrationLogs(serverId: string, limit = 100) {
  await ensureIntegrationSchema()
  const safeLimit = Math.max(1, Math.min(200, limit))
  const result = await pool.query(
    `SELECT id,"serverId",integration,level,event,details,"createdAt" FROM integration_logs WHERE "serverId"=$1 ORDER BY "createdAt" DESC LIMIT ${safeLimit}`,
    [serverId],
  )
  return result.rows
}

const DISCORD_EVENT_LABELS: Record<IntegrationEventKey, string> = {
  player_join: 'Oyuncu sunucuya katıldı',
  player_leave: 'Oyuncu sunucudan ayrıldı',
  server_start: 'Sunucu açıldı',
  server_stop: 'Sunucu kapandı',
  server_restart: 'Sunucu yeniden başlatıldı',
  server_crash: 'Sunucu çöktü',
  player_death: 'Oyuncu öldü',
  player_advancement: 'Oyuncu başarı kazandı',
  player_ban: 'Oyuncu yasaklandı',
  player_unban: 'Oyuncunun yasağı kaldırıldı',
  whitelist_add: 'Oyuncu whitelist listesine eklendi',
  whitelist_remove: 'Oyuncu whitelist listesinden çıkarıldı',
}

function eventEnabled(config: Record<string, unknown>, event: IntegrationEventKey) {
  const events = config.events
  return !!events && typeof events === 'object' && (events as Record<string, unknown>)[event] === true
}

function discordMessage(event: IntegrationEventKey, payload: Record<string, unknown>) {
  const label = DISCORD_EVENT_LABELS[event]
  const player = typeof payload.player === 'string' ? ` — **${payload.player}**` : ''
  const detail = typeof payload.detail === 'string' && payload.detail.trim() ? `\n${payload.detail.slice(0, 500)}` : ''
  return `**BLOCKCTRL · ${label}**${player}${detail}`
}

export async function emitDiscordEvent(serverId: string, event: IntegrationEventKey, payload: Record<string, unknown> = {}) {
  const integration = await getIntegration(serverId, 'discord')
  if (!integration?.enabled || !eventEnabled(integration.config, event)) return { sent: false, reason: 'disabled' }
  try {
    const secret = decryptIntegrationSecret(integration)
    const webhookUrl = secret?.webhookUrl
    if (!webhookUrl) throw new Error('Discord webhook yapılandırılmamış')
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: discordMessage(event, payload), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(7000),
    })
    if (!response.ok) throw new Error(`Discord HTTP ${response.status}`)
    await writeIntegrationLog(serverId, 'discord', event, payload, 'info')
    return { sent: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Discord bildirimi başarısız'
    await writeIntegrationLog(serverId, 'discord', `${event}.failed`, { ...payload, error: message }, 'error')
    return { sent: false, reason: message }
  }
}

export function integrationEventFromConsoleLine(line: string): { event: IntegrationEventKey; payload: Record<string, unknown> } | null {
  const text = line.replace(/\u001b\[[0-9;]*m/g, '')
  let match = text.match(/\b([A-Za-z0-9_]{1,16}) joined the game\b/i)
  if (match) return { event: 'player_join', payload: { player: match[1] } }
  match = text.match(/\b([A-Za-z0-9_]{1,16}) left the game\b/i)
  if (match) return { event: 'player_leave', payload: { player: match[1] } }
  match = text.match(/\b([A-Za-z0-9_]{1,16}) has made the advancement \[(.+?)\]/i)
  if (match) return { event: 'player_advancement', payload: { player: match[1], detail: match[2] } }
  match = text.match(/\b([A-Za-z0-9_]{1,16}) (?:was slain by|was shot by|was killed by|drowned|blew up|fell from|fell out of|burned to death|went up in flames|tried to swim in lava|starved to death|suffocated|hit the ground too hard|died)\b/i)
  if (match) return { event: 'player_death', payload: { player: match[1], detail: text.trim().slice(-500) } }
  return null
}

export function integrationEventFromCommand(line: string): { event: IntegrationEventKey; payload: Record<string, unknown> } | null {
  const trimmed = line.trim().replace(/^\//, '')
  let match = trimmed.match(/^ban\s+([A-Za-z0-9_]{1,16})\b/i)
  if (match) return { event: 'player_ban', payload: { player: match[1] } }
  match = trimmed.match(/^(?:pardon|unban)\s+([A-Za-z0-9_]{1,16})\b/i)
  if (match) return { event: 'player_unban', payload: { player: match[1] } }
  match = trimmed.match(/^whitelist\s+add\s+([A-Za-z0-9_]{1,16})\b/i)
  if (match) return { event: 'whitelist_add', payload: { player: match[1] } }
  match = trimmed.match(/^whitelist\s+remove\s+([A-Za-z0-9_]{1,16})\b/i)
  if (match) return { event: 'whitelist_remove', payload: { player: match[1] } }
  return null
}

export function publicIntegrationConfig(row: IntegrationRow | null) {
  if (!row) return null
  const config = { ...row.config }
  delete config.apiKeyHash
  return {
    kind: row.kind,
    enabled: row.enabled,
    status: row.status,
    config,
    hasSecret: !!row.secretCiphertext,
    lastTestAt: row.lastTestAt,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  }
}


export type StreamPlatform = 'youtube' | 'twitch' | 'kick'

export async function createIntegrationOauthState(input: {
  state: string
  serverId: string
  userId: string
  platform: StreamPlatform
  codeVerifier?: string | null
  expiresAt: Date
}) {
  await ensureIntegrationSchema()
  await pool.query('DELETE FROM integration_oauth_states WHERE "expiresAt" < now()')
  await pool.query(
    `INSERT INTO integration_oauth_states (state,"serverId","userId",platform,"codeVerifier","expiresAt") VALUES ($1,$2,$3,$4,$5,$6)`,
    [input.state, input.serverId, input.userId, input.platform, input.codeVerifier ?? null, input.expiresAt],
  )
}

export async function consumeIntegrationOauthState(state: string) {
  await ensureIntegrationSchema()
  const result = await pool.query(
    `DELETE FROM integration_oauth_states WHERE state=$1 AND "expiresAt">now() RETURNING state,"serverId","userId",platform,"codeVerifier","createdAt","expiresAt"`,
    [state],
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    state: String(row.state),
    serverId: String(row.serverId),
    userId: String(row.userId),
    platform: String(row.platform) as StreamPlatform,
    codeVerifier: row.codeVerifier ? String(row.codeVerifier) : null,
    createdAt: new Date(String(row.createdAt)),
    expiresAt: new Date(String(row.expiresAt)),
  }
}
