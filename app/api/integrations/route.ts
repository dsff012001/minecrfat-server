import { createHash, randomBytes } from 'node:crypto'
import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db, ensurePanelSchema } from '@/lib/db'
import { auditLog, serverPermissions, servers } from '@/lib/db/schema'
import { resolvePanelUser } from '@/lib/db/identity'
import {
  decryptIntegrationSecret,
  ensureIntegrationSchema,
  getIntegration,
  integrationEncryptionReady,
  listIntegrationLogs,
  listIntegrations,
  publicIntegrationConfig,
  upsertIntegration,
  writeIntegrationLog,
  type IntegrationKind,
} from '@/lib/integrations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

const DISCORD_EVENT_KEYS = [
  'player_join','player_leave','server_start','server_stop','server_restart','server_crash',
  'player_death','player_advancement','player_ban','player_unban','whitelist_add','whitelist_remove',
] as const

async function currentActor() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return null
  return resolvePanelUser(session.user)
}

async function authorizedServer(actor: NonNullable<Awaited<ReturnType<typeof currentActor>>>, serverId: string) {
  const server = (await db.select().from(servers).where(eq(servers.id, serverId)).limit(1))[0]
  if (!server || server.status === 'deleted') return null
  if (actor.role === 'manager') return { server, canManage: true }
  const permission = (await db.select().from(serverPermissions).where(and(eq(serverPermissions.serverId, serverId), eq(serverPermissions.userId, actor.id))).limit(1))[0]
  if (!permission) return null
  const sections = Array.isArray(permission.sections) ? permission.sections.map(String) : []
  if (!sections.includes('integrations')) return null
  return { server, canManage: permission.canReset === true }
}

function safeBooleanMap(value: unknown) {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return Object.fromEntries(DISCORD_EVENT_KEYS.map(key => [key, input[key] === true]))
}

function safeDiscordWebhook(value: unknown) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const url = new URL(raw)
  const host = url.hostname.toLowerCase()
  const allowedHost = host === 'discord.com' || host.endsWith('.discord.com') || host === 'discordapp.com' || host.endsWith('.discordapp.com')
  if (!allowedHost || !url.pathname.startsWith('/api/webhooks/')) throw new Error('Geçerli bir Discord webhook URL girin.')
  return url.toString()
}

function safeDiscordId(value: unknown, optional = true) {
  const raw = String(value ?? '').trim()
  if (!raw && optional) return ''
  if (!/^\d{10,30}$/.test(raw)) throw new Error('Discord ID alanları yalnız sayısal ID içermelidir.')
  return raw
}

function safeOrigins(value: unknown) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',')
  const result: string[] = []
  for (const item of list) {
    const raw = String(item ?? '').trim()
    if (!raw) continue
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('İzin verilen domainler http veya https olmalıdır.')
    if (!result.includes(url.origin)) result.push(url.origin)
    if (result.length > 20) throw new Error('En fazla 20 domain eklenebilir.')
  }
  return result
}

type StreamPlatform = 'youtube' | 'twitch' | 'kick'
type StreamSourceMode = 'direct' | 'link' | 'account'
type EmptyFallbackMode = 'link' | 'account' | 'remote-player' | 'spectator-camera'

function safeStreamPlatform(value: unknown): StreamPlatform | '' {
  const platform = String(value ?? '').toLowerCase()
  return platform === 'youtube' || platform === 'twitch' || platform === 'kick' ? platform : ''
}

function parseExternalStreamUrl(value: unknown) {
  const raw = String(value ?? '').trim()
  if (!raw) throw new Error('Canlı yayın linki gerekli.')
  const url = new URL(raw)
  if (url.protocol !== 'https:') throw new Error('Canlı yayın linki HTTPS olmalıdır.')
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  if (host === 'youtu.be') {
    const videoId = url.pathname.split('/').filter(Boolean)[0] ?? ''
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) throw new Error('Geçerli bir YouTube canlı yayın linki girin.')
    return { platform: 'youtube' as const, streamUrl: url.toString(), videoId }
  }
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    const parts = url.pathname.split('/').filter(Boolean)
    const videoId = url.pathname === '/watch' ? String(url.searchParams.get('v') ?? '') : parts[0] === 'live' ? String(parts[1] ?? '') : ''
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) throw new Error('YouTube için watch veya live video linki kullanın.')
    return { platform: 'youtube' as const, streamUrl: url.toString(), videoId }
  }
  if (host === 'twitch.tv') {
    const channelSlug = url.pathname.split('/').filter(Boolean)[0] ?? ''
    if (!/^[A-Za-z0-9_]{2,40}$/.test(channelSlug)) throw new Error('Geçerli bir Twitch kanal linki girin.')
    return { platform: 'twitch' as const, streamUrl: url.toString(), channelSlug }
  }
  if (host === 'kick.com') {
    const channelSlug = url.pathname.split('/').filter(Boolean)[0] ?? ''
    if (!/^[A-Za-z0-9_-]{2,60}$/.test(channelSlug)) throw new Error('Geçerli bir Kick kanal linki girin.')
    return { platform: 'kick' as const, streamUrl: url.toString(), channelSlug }
  }
  throw new Error('Yalnız YouTube, Twitch veya Kick canlı yayın linkleri destekleniyor.')
}

function accountConfigKey(platform: StreamPlatform) { return `${platform}Account` }
function connectedStreamAccount(config: Record<string, unknown>, platform: StreamPlatform) {
  const account = config[accountConfigKey(platform)]
  return !!account && typeof account === 'object' && (account as Record<string, unknown>).connected === true
}

function safeLiveConfig(value: unknown) {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const allowedModes = new Set(['random','round-robin','longest-online','newest','manual'])
  const selectionMode = allowedModes.has(String(input.selectionMode)) ? String(input.selectionMode) : 'random'
  const rotateSecondsRaw = Number(input.rotateSeconds ?? 600)
  const rotateSeconds = rotateSecondsRaw === 0 ? 0 : Math.max(30, Math.min(86400, Number.isFinite(rotateSecondsRaw) ? Math.round(rotateSecondsRaw) : 600))
  const sourceMode = (['direct','link','account'].includes(String(input.sourceMode)) ? String(input.sourceMode) : 'direct') as StreamSourceMode
  const requestedPlatform = safeStreamPlatform(input.platform)
  const link = sourceMode === 'link' ? parseExternalStreamUrl(input.streamUrl) : null
  const platform = link?.platform ?? requestedPlatform
  if (sourceMode === 'account' && !platform) throw new Error('Bağlanacak yayın platformunu seçin.')

  const emptyFallbackEnabled = input.emptyFallbackEnabled === true
  const rawFallbackMode = String(input.emptyFallbackMode ?? 'link')
  const emptyFallbackMode = (['link','account','remote-player','spectator-camera'].includes(rawFallbackMode) ? rawFallbackMode : 'link') as EmptyFallbackMode
  const emptyFallbackPlatform = safeStreamPlatform(input.emptyFallbackPlatform)
  const emptyFallbackUrl = String(input.emptyFallbackUrl ?? '').trim()
  const emptyFallbackLink = emptyFallbackEnabled && emptyFallbackMode === 'link' && emptyFallbackUrl ? parseExternalStreamUrl(emptyFallbackUrl) : null
  const emptyFallbackServerId = String(input.emptyFallbackServerId ?? '').trim()
  const emptyFallbackCameraKey = String(input.emptyFallbackCameraKey ?? '').trim()
  if (emptyFallbackEnabled && emptyFallbackMode === 'account' && !emptyFallbackPlatform) throw new Error('Fallback için YouTube, Twitch veya Kick hesabı seçin.')
  if (emptyFallbackEnabled && emptyFallbackMode === 'link' && !emptyFallbackLink) throw new Error('Fallback için geçerli bir YouTube, Twitch veya Kick canlı yayın linki girin.')
  if (emptyFallbackEnabled && emptyFallbackMode === 'remote-player' && !/^[0-9a-f-]{36}$/i.test(emptyFallbackServerId)) throw new Error('Başka oyuncu POV fallback’i için geçerli sunucu ID gerekli.')
  if (emptyFallbackEnabled && emptyFallbackMode === 'spectator-camera' && !/^[A-Za-z0-9._:-]{2,120}$/.test(emptyFallbackCameraKey)) throw new Error('Dış kamera fallback’i için geçerli kamera kaynak anahtarı gerekli.')
  const clampSeconds = (raw: unknown, fallback: number, min: number, max: number) => { const n = Number(raw); return Math.max(min, Math.min(max, Number.isFinite(n) ? Math.round(n) : fallback)) }

  return {
    sourceMode, platform,
    streamUrl: link?.streamUrl ?? '',
    videoId: link && 'videoId' in link ? link.videoId : '',
    channelSlug: link && 'channelSlug' in link ? link.channelSlug : '',
    transport: sourceMode === 'direct' ? 'webrtc' : 'platform-embed',
    recording: false, storageMode: 'none', framePersistence: false,
    selectionMode, rotateSeconds,
    switchOnLeave: input.switchOnLeave !== false,
    switchOnShareStop: input.switchOnShareStop !== false,
    switchOnDisconnect: input.switchOnDisconnect !== false,
    switchOnAfk: input.switchOnAfk === true,
    avoidImmediateRepeat: input.avoidImmediateRepeat !== false,
    emptyFallbackEnabled,
    emptyFallbackMode,
    emptyFallbackPlatform: emptyFallbackLink?.platform ?? emptyFallbackPlatform,
    emptyFallbackUrl: emptyFallbackLink?.streamUrl ?? '',
    emptyFallbackServerId: emptyFallbackMode === 'remote-player' ? emptyFallbackServerId : '',
    emptyFallbackCameraKey: emptyFallbackMode === 'spectator-camera' ? emptyFallbackCameraKey : '',
    emptyFallbackDelaySeconds: clampSeconds(input.emptyFallbackDelaySeconds, 60, 5, 3600),
    emptyFallbackLockSeconds: clampSeconds(input.emptyFallbackLockSeconds, 300, 0, 86400),
    returnToPlayersDelaySeconds: clampSeconds(input.returnToPlayersDelaySeconds, 30, 0, 3600),
  }
}

function runtimeCapabilities() {
  return {
    discordWebhook: true,
    discordBotWorker: !!process.env.DISCORD_BOT_WORKER_URL,
    webApi: true,
    websocket: false,
    liveStreamGateway: !!process.env.LIVE_STREAM_GATEWAY_URL,
    streamAccounts: {
      youtube: !!process.env.YOUTUBE_CLIENT_ID && !!process.env.YOUTUBE_CLIENT_SECRET,
      twitch: !!process.env.TWITCH_CLIENT_ID && !!process.env.TWITCH_CLIENT_SECRET,
      kick: !!process.env.KICK_CLIENT_ID && !!process.env.KICK_CLIENT_SECRET,
    },
  }
}

function liveSourceReady(row: Awaited<ReturnType<typeof getIntegration>>, capabilities = runtimeCapabilities()) {
  if (!row) return false
  const sourceMode = String(row.config.sourceMode ?? 'direct') as StreamSourceMode
  if (sourceMode === 'direct') return capabilities.liveStreamGateway
  if (sourceMode === 'link') { try { parseExternalStreamUrl(row.config.streamUrl); return true } catch { return false } }
  const platform = safeStreamPlatform(row.config.platform)
  return !!platform && connectedStreamAccount(row.config, platform)
}

async function persistLiveRuntimeState(serverId: string, userId: string, row: NonNullable<Awaited<ReturnType<typeof getIntegration>>>, patch: Record<string, unknown>) {
  const config = { ...row.config, ...patch }
  await upsertIntegration({ serverId, kind: 'live-stream', userId, enabled: row.enabled, status: row.status, config, preserveSecret: true, lastTestAt: row.lastTestAt, lastError: row.lastError })
  row.config = config
  return config
}

async function resolveConnectedAccountStream(serverId: string, actorId: string, row: NonNullable<Awaited<ReturnType<typeof getIntegration>>>, platform: StreamPlatform) {
  const account = row.config[accountConfigKey(platform)] as Record<string, unknown>
  if (platform === 'twitch') {
    const channelSlug = String(account?.login ?? '')
    if (!channelSlug) throw new Error('Twitch kanal adı bulunamadı.')
    return { provider: 'twitch', live: true, channelSlug, streamUrl: `https://www.twitch.tv/${channelSlug}`, message: 'Twitch hesabı player için hazır.' }
  }
  if (platform === 'kick') {
    const channelSlug = String(account?.channelSlug ?? account?.username ?? '')
    if (!channelSlug) throw new Error('Kick kanal adı bulunamadı.')
    return { provider: 'kick', live: true, channelSlug, streamUrl: `https://kick.com/${channelSlug}`, message: 'Kick hesabı player için hazır.' }
  }
  let secret = decryptIntegrationSecret(row) ?? {}
  let accessToken = secret.youtubeAccessToken
  const channelId = String(account?.channelId ?? '')
  const expiresAt = Date.parse(String(secret.youtubeExpiresAt ?? ''))
  if ((!accessToken || (Number.isFinite(expiresAt) && expiresAt < Date.now() + 60_000)) && secret.youtubeRefreshToken && process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET) {
    const form = new URLSearchParams({ client_id: process.env.YOUTUBE_CLIENT_ID, client_secret: process.env.YOUTUBE_CLIENT_SECRET, refresh_token: secret.youtubeRefreshToken, grant_type: 'refresh_token' })
    const refreshed = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, cache: 'no-store', signal: AbortSignal.timeout(7000) })
    const refreshedBody = await refreshed.json().catch(() => ({})) as Record<string, unknown>
    if (refreshed.ok && refreshedBody.access_token) {
      accessToken = String(refreshedBody.access_token)
      secret = { ...secret, youtubeAccessToken: accessToken, youtubeExpiresAt: new Date(Date.now() + Number(refreshedBody.expires_in ?? 3600) * 1000).toISOString() }
      await upsertIntegration({ serverId, kind: 'live-stream', userId: actorId, config: row.config, secret, enabled: row.enabled, status: row.status, lastTestAt: row.lastTestAt, lastError: row.lastError })
    }
  }
  if (!accessToken || !channelId) throw new Error('YouTube hesap tokenı veya kanal ID bulunamadı. Hesabı yeniden bağlayın.')
  const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search')
  searchUrl.searchParams.set('part','id'); searchUrl.searchParams.set('channelId',channelId); searchUrl.searchParams.set('eventType','live'); searchUrl.searchParams.set('type','video'); searchUrl.searchParams.set('maxResults','1')
  const response = await fetch(searchUrl, { headers: { authorization: `Bearer ${accessToken}` }, cache: 'no-store', signal: AbortSignal.timeout(7000) })
  if (!response.ok) throw new Error(`YouTube canlı yayın sorgusu başarısız (HTTP ${response.status}). Hesabı yeniden bağlamanız gerekebilir.`)
  const payload = await response.json() as { items?: Array<{ id?: { videoId?: string } }> }
  const videoId = String(payload.items?.[0]?.id?.videoId ?? '')
  if (!videoId) return { provider: 'youtube', live: false, channelId, streamUrl: `https://www.youtube.com/channel/${channelId}/live`, message: 'Bağlı YouTube kanalında şu anda aktif canlı yayın bulunamadı.' }
  return { provider: 'youtube', live: true, videoId, channelId, streamUrl: `https://www.youtube.com/watch?v=${videoId}`, message: 'YouTube canlı yayını bulundu.' }
}

async function resolveEmptyFallback(serverId: string, actor: NonNullable<Awaited<ReturnType<typeof currentActor>>>, row: NonNullable<Awaited<ReturnType<typeof getIntegration>>>, capabilities = runtimeCapabilities()) {
  const mode = String(row.config.emptyFallbackMode ?? 'link') as EmptyFallbackMode
  if (mode === 'link') {
    const parsed = parseExternalStreamUrl(row.config.emptyFallbackUrl)
    return { provider: parsed.platform, live: true, ...parsed, fallback: true, fallbackMode: mode, message: `${parsed.platform} fallback yayını aktif.` }
  }
  if (mode === 'account') {
    const platform = safeStreamPlatform(row.config.emptyFallbackPlatform)
    if (!platform || !connectedStreamAccount(row.config, platform)) throw new Error('Fallback için seçilen platform hesabı bağlı değil.')
    return { ...(await resolveConnectedAccountStream(serverId, actor.id, row, platform)), fallback: true, fallbackMode: mode }
  }
  if (!capabilities.liveStreamGateway) throw new Error('Başka oyuncu POV / dış kamera fallback’i için LIVE_STREAM_GATEWAY_URL gerekli.')
  if (mode === 'remote-player') {
    const targetServerId = String(row.config.emptyFallbackServerId ?? '')
    if (!(await authorizedServer(actor, targetServerId))) throw new Error('Fallback hedef sunucusuna erişiminiz yok veya sunucu bulunamadı.')
    return { provider: 'direct', live: true, fallback: true, fallbackMode: mode, targetServerId, gatewayUrl: process.env.LIVE_STREAM_GATEWAY_URL, view: 'player-pov', message: 'Başka sunucudaki uygun oyuncunun POV yayınına geçildi.' }
  }
  const cameraKey = String(row.config.emptyFallbackCameraKey ?? '')
  return { provider: 'direct', live: true, fallback: true, fallbackMode: mode, cameraKey, gatewayUrl: process.env.LIVE_STREAM_GATEWAY_URL, view: 'spectator-camera', message: 'Dış / spectator kamera yayınına geçildi.' }
}

function statusMessage(kind: IntegrationKind, row: Awaited<ReturnType<typeof getIntegration>>, capabilities = runtimeCapabilities()) {
  if (!row) return 'Yapılandırılmadı'
  if (kind === 'discord-bot' && !capabilities.discordBotWorker) return row.lastTestAt ? 'Kimlik bilgileri doğrulandı · Bot worker gerekli' : 'Bot worker gerekli'
  if (kind === 'live-stream') {
    const mode = String(row.config.sourceMode ?? 'direct')
    if (mode === 'direct' && !capabilities.liveStreamGateway) return 'Doğrudan WebRTC geçidi gerekli'
    if (mode === 'account') {
      const platform = safeStreamPlatform(row.config.platform)
      if (!platform || !connectedStreamAccount(row.config, platform)) return 'Yayın hesabı bağlantısı gerekli'
    }
    if (mode === 'link' && !row.config.streamUrl) return 'Canlı yayın linki gerekli'
  }
  if (row.enabled) return 'Aktif'
  return row.status === 'tested' ? 'Test edildi · Kapalı' : row.status === 'configured' ? 'Yapılandırıldı · Kapalı' : 'Kapalı'
}

async function audit(userId: string, serverId: string, action: string, details: Record<string, unknown> = {}) {
  await db.insert(auditLog).values({ userId, action, resourceType: 'server-integration', resourceId: serverId, details })
}

async function requireRecord(serverId: string, kind: IntegrationKind) {
  const row = await getIntegration(serverId, kind)
  if (!row) throw new Error('Entegrasyon henüz yapılandırılmamış.')
  return row
}

function responseError(error: unknown, status = 400) {
  const message = error instanceof Error ? error.message : 'Entegrasyon işlemi başarısız'
  return NextResponse.json({ error: message }, { status })
}

export async function GET(request: NextRequest) {
  try {
    await ensurePanelSchema()
    await ensureIntegrationSchema()
    const actor = await currentActor()
    if (!actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!actor.approved) return NextResponse.json({ error: 'Approval required' }, { status: 403 })
    const serverId = request.nextUrl.searchParams.get('serverId') ?? ''
    const access = await authorizedServer(actor, serverId)
    if (!access) return NextResponse.json({ error: 'Entegrasyonlar bölümüne erişiminiz yok' }, { status: 403 })
    const rows = await listIntegrations(serverId)
    const byKind = new Map(rows.map(row => [row.kind, row]))
    const capabilities = runtimeCapabilities()
    const integrations = Object.fromEntries((['discord','discord-bot','web-api','live-stream'] as IntegrationKind[]).map(kind => {
      const row = byKind.get(kind) ?? null
      const publicRow = publicIntegrationConfig(row)
      return [kind, { ...(publicRow ?? {}), statusLabel: statusMessage(kind, row, capabilities) }]
    }))
    const logs = await listIntegrationLogs(serverId, 100)
    return NextResponse.json({ integrations, logs, encryptionReady: integrationEncryptionReady(), capabilities, canManage: access.canManage }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return responseError(error, 500)
  }
}

export async function POST(request: NextRequest) {
  try {
    await ensurePanelSchema()
    await ensureIntegrationSchema()
    const actor = await currentActor()
    if (!actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!actor.approved) return NextResponse.json({ error: 'Approval required' }, { status: 403 })
    const body = await request.json() as Record<string, unknown>
    const serverId = String(body.serverId ?? '')
    const action = String(body.action ?? '')
    const access = await authorizedServer(actor, serverId)
    if (!access) return NextResponse.json({ error: 'Entegrasyonlar bölümüne erişiminiz yok' }, { status: 403 })
    if (!access.canManage) return NextResponse.json({ error: 'Entegrasyon ayarlarını değiştirme yetkiniz yok' }, { status: 403 })
    const capabilities = runtimeCapabilities()

    if (action === 'save-discord') {
      const existing = await getIntegration(serverId, 'discord')
      const webhookUrl = safeDiscordWebhook(body.webhookUrl)
      const events = safeBooleanMap(body.events)
      const row = await upsertIntegration({
        serverId, kind: 'discord', userId: actor.id, enabled: existing?.enabled ?? false,
        status: 'configured', config: { events },
        secret: webhookUrl ? { webhookUrl } : undefined, preserveSecret: !webhookUrl, lastError: null,
      })
      await writeIntegrationLog(serverId, 'discord', 'configuration.updated', { events })
      await audit(actor.id, serverId, 'integration.discord.save', { events })
      return NextResponse.json({ ok: true, integration: publicIntegrationConfig(row) })
    }

    if (action === 'test-discord') {
      const row = await requireRecord(serverId, 'discord')
      const secret = decryptIntegrationSecret(row)
      if (!secret?.webhookUrl) throw new Error('Önce Discord webhook URL kaydedin.')
      const response = await fetch(secret.webhookUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: `**BLOCKCTRL · Test başarılı**\n${access.server.name} sunucusu Discord entegrasyonuna bağlandı.`, allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(7000),
      })
      if (!response.ok) throw new Error(`Discord webhook testi başarısız (HTTP ${response.status})`)
      await upsertIntegration({ serverId, kind: 'discord', userId: actor.id, status: 'tested', preserveSecret: true, lastTestAt: new Date(), lastError: null })
      await writeIntegrationLog(serverId, 'discord', 'connection.tested', { ok: true })
      await audit(actor.id, serverId, 'integration.discord.test')
      return NextResponse.json({ ok: true, message: 'Discord test mesajı gönderildi.' })
    }

    if (action === 'toggle-discord') {
      const row = await requireRecord(serverId, 'discord')
      const enabled = body.enabled === true
      if (enabled && !row.secretCiphertext) throw new Error('Discord webhook yapılandırılmadan entegrasyon açılamaz.')
      const updated = await upsertIntegration({ serverId, kind: 'discord', userId: actor.id, enabled, status: enabled ? 'active' : 'configured', preserveSecret: true, lastError: null })
      await writeIntegrationLog(serverId, 'discord', enabled ? 'integration.enabled' : 'integration.disabled')
      await audit(actor.id, serverId, enabled ? 'integration.discord.enable' : 'integration.discord.disable')
      return NextResponse.json({ ok: true, integration: publicIntegrationConfig(updated) })
    }

    if (action === 'save-discord-bot') {
      const token = String(body.botToken ?? '').trim()
      const config = {
        guildId: safeDiscordId(body.guildId),
        commandChannelId: safeDiscordId(body.commandChannelId),
        logChannelId: safeDiscordId(body.logChannelId),
        adminRoleId: safeDiscordId(body.adminRoleId),
      }
      const existing = await getIntegration(serverId, 'discord-bot')
      const row = await upsertIntegration({
        serverId, kind: 'discord-bot', userId: actor.id, enabled: existing?.enabled ?? false, status: 'configured', config,
        secret: token ? { botToken: token } : undefined, preserveSecret: !token, lastError: null,
      })
      await writeIntegrationLog(serverId, 'discord-bot', 'configuration.updated', { guildId: config.guildId })
      await audit(actor.id, serverId, 'integration.discord-bot.save', { guildId: config.guildId })
      return NextResponse.json({ ok: true, integration: publicIntegrationConfig(row) })
    }

    if (action === 'test-discord-bot') {
      const row = await requireRecord(serverId, 'discord-bot')
      const secret = decryptIntegrationSecret(row)
      if (!secret?.botToken) throw new Error('Önce Discord bot token kaydedin.')
      const me = await fetch('https://discord.com/api/v10/users/@me', { headers: { authorization: `Bot ${secret.botToken}` }, cache: 'no-store', signal: AbortSignal.timeout(7000) })
      if (!me.ok) throw new Error(`Discord bot token doğrulanamadı (HTTP ${me.status})`)
      const bot = await me.json() as { id?: string; username?: string }
      const guildId = String(row.config.guildId ?? '')
      if (guildId) {
        const guild = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, { headers: { authorization: `Bot ${secret.botToken}` }, cache: 'no-store', signal: AbortSignal.timeout(7000) })
        if (!guild.ok) throw new Error(`Bot belirtilen Discord sunucusuna erişemiyor (HTTP ${guild.status})`)
      }
      await upsertIntegration({ serverId, kind: 'discord-bot', userId: actor.id, status: 'tested', preserveSecret: true, lastTestAt: new Date(), lastError: null })
      await writeIntegrationLog(serverId, 'discord-bot', 'credentials.tested', { botId: bot.id ?? null, username: bot.username ?? null })
      await audit(actor.id, serverId, 'integration.discord-bot.test')
      return NextResponse.json({ ok: true, message: `Bot kimliği doğrulandı${bot.username ? `: ${bot.username}` : ''}.`, workerReady: capabilities.discordBotWorker })
    }

    if (action === 'toggle-discord-bot') {
      const row = await requireRecord(serverId, 'discord-bot')
      const enabled = body.enabled === true
      if (enabled && !capabilities.discordBotWorker) return NextResponse.json({ error: 'Discord Bot worker henüz yapılandırılmadı. Kimlik bilgileri test edilebilir ancak bot çalışıyor olarak gösterilmeyecek.' }, { status: 409 })
      if (enabled && !row.secretCiphertext) throw new Error('Bot token kaydedilmeden entegrasyon açılamaz.')
      const updated = await upsertIntegration({ serverId, kind: 'discord-bot', userId: actor.id, enabled, status: enabled ? 'active' : 'configured', preserveSecret: true, lastError: null })
      await writeIntegrationLog(serverId, 'discord-bot', enabled ? 'integration.enabled' : 'integration.disabled')
      await audit(actor.id, serverId, enabled ? 'integration.discord-bot.enable' : 'integration.discord-bot.disable')
      return NextResponse.json({ ok: true, integration: publicIntegrationConfig(updated) })
    }

    if (action === 'save-web-api') {
      const existing = await getIntegration(serverId, 'web-api')
      const config = { ...(existing?.config ?? {}), allowedOrigins: safeOrigins(body.allowedOrigins) }
      const row = await upsertIntegration({ serverId, kind: 'web-api', userId: actor.id, enabled: existing?.enabled ?? false, status: existing?.config?.apiKeyHash ? 'configured' : 'not_configured', config, preserveSecret: true, lastError: null })
      await writeIntegrationLog(serverId, 'web-api', 'configuration.updated', { allowedOrigins: config.allowedOrigins })
      await audit(actor.id, serverId, 'integration.web-api.save', { allowedOrigins: config.allowedOrigins })
      return NextResponse.json({ ok: true, integration: publicIntegrationConfig(row) })
    }

    if (action === 'rotate-web-api-key') {
      const existing = await getIntegration(serverId, 'web-api')
      const apiKey = `bc_live_${randomBytes(32).toString('base64url')}`
      const apiKeyHash = createHash('sha256').update(apiKey).digest('hex')
      const config = { ...(existing?.config ?? {}), apiKeyHash, apiKeyPrefix: apiKey.slice(0, 16), keyCreatedAt: new Date().toISOString() }
      const row = await upsertIntegration({ serverId, kind: 'web-api', userId: actor.id, enabled: existing?.enabled ?? false, status: 'configured', config, preserveSecret: true, lastError: null })
      await writeIntegrationLog(serverId, 'web-api', 'api-key.rotated', { prefix: config.apiKeyPrefix })
      await audit(actor.id, serverId, 'integration.web-api.rotate-key', { prefix: config.apiKeyPrefix })
      return NextResponse.json({ ok: true, apiKey, integration: publicIntegrationConfig(row), message: 'API anahtarı yalnız bu yanıtta gösterilir. Güvenli bir yerde saklayın.' })
    }

    if (action === 'revoke-web-api-key') {
      const existing = await requireRecord(serverId, 'web-api')
      const config = { ...existing.config }
      delete config.apiKeyHash
      delete config.apiKeyPrefix
      delete config.keyCreatedAt
      const row = await upsertIntegration({ serverId, kind: 'web-api', userId: actor.id, enabled: false, status: 'not_configured', config, preserveSecret: true, lastError: null })
      await writeIntegrationLog(serverId, 'web-api', 'api-key.revoked')
      await audit(actor.id, serverId, 'integration.web-api.revoke-key')
      return NextResponse.json({ ok: true, integration: publicIntegrationConfig(row) })
    }

    if (action === 'toggle-web-api') {
      const row = await requireRecord(serverId, 'web-api')
      const enabled = body.enabled === true
      if (enabled && !row.config.apiKeyHash) throw new Error('Önce bir Web API anahtarı oluşturun.')
      const updated = await upsertIntegration({ serverId, kind: 'web-api', userId: actor.id, enabled, status: enabled ? 'active' : 'configured', preserveSecret: true, lastError: null })
      await writeIntegrationLog(serverId, 'web-api', enabled ? 'integration.enabled' : 'integration.disabled')
      await audit(actor.id, serverId, enabled ? 'integration.web-api.enable' : 'integration.web-api.disable')
      return NextResponse.json({ ok: true, integration: publicIntegrationConfig(updated) })
    }

    if (action === 'test-web-api') {
      const row = await requireRecord(serverId, 'web-api')
      if (!row.config.apiKeyHash) throw new Error('Web API anahtarı oluşturulmamış.')
      await upsertIntegration({ serverId, kind: 'web-api', userId: actor.id, status: row.enabled ? 'active' : 'tested', preserveSecret: true, lastTestAt: new Date(), lastError: null })
      await writeIntegrationLog(serverId, 'web-api', 'configuration.tested', { enabled: row.enabled })
      return NextResponse.json({ ok: true, message: 'Web API yapılandırması geçerli.' })
    }

    if (action === 'save-live-stream') {
      const existing = await getIntegration(serverId, 'live-stream')
      const safe = safeLiveConfig(body.config)
      const config: Record<string, unknown> = { ...(existing?.config ?? {}), ...safe }
      if (safe.sourceMode !== 'link') { delete config.streamUrl; delete config.videoId; delete config.channelSlug }
      const ready = safe.sourceMode === 'direct' ? capabilities.liveStreamGateway
        : safe.sourceMode === 'link' ? true
        : !!safe.platform && connectedStreamAccount(config, safe.platform as StreamPlatform)
      const row = await upsertIntegration({ serverId, kind: 'live-stream', userId: actor.id, enabled: ready ? existing?.enabled ?? false : false, status: ready ? 'configured' : safe.sourceMode === 'account' ? 'account_required' : 'client_required', config, preserveSecret: true, lastError: null })
      await writeIntegrationLog(serverId, 'live-stream', 'configuration.updated', { ...safe, recording: false, storageMode: 'none' })
      await audit(actor.id, serverId, 'integration.live-stream.save', { sourceMode: safe.sourceMode, platform: safe.platform, recording: false })
      return NextResponse.json({ ok: true, integration: publicIntegrationConfig(row), message: 'Canlı yayın ayarları kaydedildi. Görüntü/video kaydı kapalıdır; veri yalnız anlık iletilir.' })
    }

    if (action === 'toggle-live-stream') {
      const row = await requireRecord(serverId, 'live-stream')
      const enabled = body.enabled === true
      if (enabled && !liveSourceReady(row, capabilities)) return NextResponse.json({ error: 'Seçili canlı yayın kaynağı hazır değil. Doğrudan modda WebRTC geçidi, link modunda geçerli yayın linki, hesap modunda bağlı platform hesabı gerekir.' }, { status: 409 })
      const updated = await upsertIntegration({ serverId, kind: 'live-stream', userId: actor.id, enabled, status: enabled ? 'active' : 'configured', preserveSecret: true, lastError: null })
      await writeIntegrationLog(serverId, 'live-stream', enabled ? 'integration.enabled' : 'integration.disabled', { sourceMode: row.config.sourceMode ?? 'direct' })
      await audit(actor.id, serverId, enabled ? 'integration.live-stream.enable' : 'integration.live-stream.disable')
      return NextResponse.json({ ok: true, integration: publicIntegrationConfig(updated) })
    }

    if (action === 'resolve-live-stream' || action === 'test-live-stream') {
      const row = await requireRecord(serverId, 'live-stream')
      const sourceMode = String(row.config.sourceMode ?? 'direct') as StreamSourceMode
      if (sourceMode === 'direct') {
        const playerCount = Math.max(0, Number(access.server.playerCount ?? 0))
        const fallbackEnabled = row.config.emptyFallbackEnabled === true
        const now = Date.now()
        const fallbackDelayMs = Math.max(5, Number(row.config.emptyFallbackDelaySeconds ?? 60)) * 1000
        const fallbackLockMs = Math.max(0, Number(row.config.emptyFallbackLockSeconds ?? 300)) * 1000
        const returnDelayMs = Math.max(0, Number(row.config.returnToPlayersDelaySeconds ?? 30)) * 1000
        let emptySince = Date.parse(String(row.config.emptySince ?? ''))
        let fallbackActivatedAt = Date.parse(String(row.config.fallbackActivatedAt ?? ''))
        let playersReturnedAt = Date.parse(String(row.config.playersReturnedAt ?? ''))

        if (playerCount <= 0 && fallbackEnabled) {
          if (!Number.isFinite(emptySince)) { emptySince = now; await persistLiveRuntimeState(serverId, actor.id, row, { emptySince: new Date(now).toISOString(), playersReturnedAt: null }) }
          const waited = now - emptySince
          if (waited >= fallbackDelayMs) {
            if (!Number.isFinite(fallbackActivatedAt)) { fallbackActivatedAt = now; await persistLiveRuntimeState(serverId, actor.id, row, { fallbackActivatedAt: new Date(now).toISOString(), playersReturnedAt: null }) }
            const fallback = await resolveEmptyFallback(serverId, actor, row, capabilities)
            const lockedUntil = fallbackActivatedAt + fallbackLockMs
            return NextResponse.json({ ok: true, ...fallback, playerCount, fallbackReason: 'no-players', fallbackActivatedAt: new Date(fallbackActivatedAt).toISOString(), lockedUntil: fallbackLockMs ? new Date(lockedUntil).toISOString() : null })
          }
          return NextResponse.json({ ok: true, provider: 'direct', live: false, playerCount, waitingForFallback: true, fallbackInSeconds: Math.max(0, Math.ceil((fallbackDelayMs - waited) / 1000)), message: 'Sunucuda oyuncu yok. Fallback yayına geçiş süresi bekleniyor.' })
        }

        if (playerCount > 0 && Number.isFinite(fallbackActivatedAt)) {
          const lockedUntil = fallbackActivatedAt + fallbackLockMs
          if (now < lockedUntil) {
            const fallback = await resolveEmptyFallback(serverId, actor, row, capabilities)
            return NextResponse.json({ ok: true, ...fallback, playerCount, fallbackReason: 'minimum-lock', lockedUntil: new Date(lockedUntil).toISOString(), message: `${fallback.message} Minimum fallback süresi tamamlanana kadar kilitli.` })
          }
          if (!Number.isFinite(playersReturnedAt)) { playersReturnedAt = now; await persistLiveRuntimeState(serverId, actor.id, row, { playersReturnedAt: new Date(now).toISOString() }) }
          if (now - playersReturnedAt < returnDelayMs) {
            const fallback = await resolveEmptyFallback(serverId, actor, row, capabilities)
            return NextResponse.json({ ok: true, ...fallback, playerCount, fallbackReason: 'return-delay', returnToPlayersInSeconds: Math.max(0, Math.ceil((returnDelayMs - (now - playersReturnedAt)) / 1000)), message: `${fallback.message} Oyuncu POV'a dönmeden önce bağlantının stabil kalması bekleniyor.` })
          }
          await persistLiveRuntimeState(serverId, actor.id, row, { emptySince: null, fallbackActivatedAt: null, playersReturnedAt: null })
        } else if (playerCount > 0 && (row.config.emptySince || row.config.playersReturnedAt)) {
          await persistLiveRuntimeState(serverId, actor.id, row, { emptySince: null, fallbackActivatedAt: null, playersReturnedAt: null })
        }

        if (!capabilities.liveStreamGateway) return NextResponse.json({ error: 'LIVE_STREAM_GATEWAY_URL yapılandırılmadı; doğrudan WebRTC akışı test edilemiyor.' }, { status: 409 })
        const response = await fetch(`${String(process.env.LIVE_STREAM_GATEWAY_URL).replace(/\/$/, '')}/health`, { cache: 'no-store', signal: AbortSignal.timeout(7000) })
        if (!response.ok) throw new Error(`Canlı yayın ağ geçidi HTTP ${response.status}`)
        await upsertIntegration({ serverId, kind: 'live-stream', userId: actor.id, status: row.enabled ? 'active' : 'tested', preserveSecret: true, lastTestAt: new Date(), lastError: null })
        await writeIntegrationLog(serverId, 'live-stream', 'gateway.tested', { recording: false, storageMode: 'none', playerCount })
        return NextResponse.json({ ok: true, provider: 'direct', live: row.enabled, playerCount, view: 'player-pov', message: 'Oyuncu POV WebRTC akışı aktif. Veri diske kaydedilmeden anlık iletilir.' })
      }
      if (sourceMode === 'link') {
        const parsed = parseExternalStreamUrl(row.config.streamUrl)
        await upsertIntegration({ serverId, kind: 'live-stream', userId: actor.id, status: row.enabled ? 'active' : 'tested', preserveSecret: true, lastTestAt: new Date(), lastError: null })
        return NextResponse.json({ ok: true, live: true, ...parsed, message: `${parsed.platform} yayın linki oynatılmaya hazır.` })
      }
      const platform = safeStreamPlatform(row.config.platform)
      if (!platform || !connectedStreamAccount(row.config, platform)) throw new Error('Seçili platform hesabı bağlı değil.')
      return NextResponse.json({ ok: true, ...(await resolveConnectedAccountStream(serverId, actor.id, row, platform)) })
    }

    if (action === 'disconnect-stream-account') {
      const row = await requireRecord(serverId, 'live-stream')
      const platform = safeStreamPlatform(body.platform)
      if (!platform) throw new Error('Geçersiz yayın platformu.')
      const config = { ...row.config }
      delete config[accountConfigKey(platform)]
      if (String(config.sourceMode) === 'account' && String(config.platform) === platform) { config.sourceMode = 'direct'; config.platform = '' }
      const existingSecret = decryptIntegrationSecret(row) ?? {}
      for (const suffix of ['AccessToken','RefreshToken','ExpiresAt']) delete existingSecret[`${platform}${suffix}`]
      const updated = await upsertIntegration({ serverId, kind: 'live-stream', userId: actor.id, enabled: false, status: 'configured', config, secret: Object.keys(existingSecret).length ? existingSecret : null, preserveSecret: false, lastError: null })
      await writeIntegrationLog(serverId, 'live-stream', 'account.disconnected', { platform })
      await audit(actor.id, serverId, 'integration.live-stream.account-disconnect', { platform })
      return NextResponse.json({ ok: true, integration: publicIntegrationConfig(updated), message: `${platform} hesabı bağlantısı kaldırıldı.` })
    }

    return NextResponse.json({ error: 'Bilinmeyen entegrasyon işlemi' }, { status: 400 })
  } catch (error) {
    try {
      return responseError(error, 400)
    } catch {
      return NextResponse.json({ error: 'Entegrasyon işlemi başarısız' }, { status: 500 })
    }
  }
}
