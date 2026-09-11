import { NextRequest, NextResponse } from 'next/server'
import { db, ensurePanelSchema } from '@/lib/db'
import { auditLog } from '@/lib/db/schema'
import {
  consumeIntegrationOauthState,
  decryptIntegrationSecret,
  getIntegration,
  integrationEncryptionReady,
  upsertIntegration,
  writeIntegrationLog,
  type StreamPlatform,
} from '@/lib/integrations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function appBaseUrl(request: NextRequest) {
  return (process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL ?? request.nextUrl.origin).replace(/\/$/, '')
}

function platformConfig(platform: StreamPlatform) {
  if (platform === 'youtube') return { clientId: process.env.YOUTUBE_CLIENT_ID ?? '', clientSecret: process.env.YOUTUBE_CLIENT_SECRET ?? '', tokenUrl: 'https://oauth2.googleapis.com/token' }
  if (platform === 'twitch') return { clientId: process.env.TWITCH_CLIENT_ID ?? '', clientSecret: process.env.TWITCH_CLIENT_SECRET ?? '', tokenUrl: 'https://id.twitch.tv/oauth2/token' }
  return { clientId: process.env.KICK_CLIENT_ID ?? '', clientSecret: process.env.KICK_CLIENT_SECRET ?? '', tokenUrl: 'https://id.kick.com/oauth/token' }
}

async function exchangeToken(platform: StreamPlatform, code: string, redirectUri: string, verifier: string | null) {
  const cfg = platformConfig(platform)
  if (!cfg.clientId || !cfg.clientSecret) throw new Error(`${platform.toUpperCase()} OAuth yapılandırması eksik.`)
  const form = new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri })
  if (platform === 'kick') {
    if (!verifier) throw new Error('Kick PKCE doğrulayıcısı bulunamadı.')
    form.set('code_verifier', verifier)
  }
  const response = await fetch(cfg.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, cache: 'no-store', signal: AbortSignal.timeout(10000) })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new Error(`${platform.toUpperCase()} token değişimi başarısız (HTTP ${response.status}).`)
  const accessToken = String(body.access_token ?? '')
  if (!accessToken) throw new Error(`${platform.toUpperCase()} access token dönmedi.`)
  return { accessToken, refreshToken: String(body.refresh_token ?? ''), expiresIn: Number(body.expires_in ?? 0) }
}

async function fetchAccount(platform: StreamPlatform, accessToken: string) {
  if (platform === 'youtube') {
    const response = await fetch('https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true', { headers: { authorization: `Bearer ${accessToken}` }, cache: 'no-store', signal: AbortSignal.timeout(10000) })
    const body = await response.json().catch(() => ({})) as { items?: Array<{ id?: string; snippet?: { title?: string; customUrl?: string; thumbnails?: { default?: { url?: string } } } }> }
    if (!response.ok) throw new Error(`YouTube kanal bilgisi alınamadı (HTTP ${response.status}).`)
    const channel = body.items?.[0]
    if (!channel?.id) throw new Error('Bağlı Google hesabında YouTube kanalı bulunamadı.')
    return { connected: true, channelId: channel.id, title: channel.snippet?.title ?? 'YouTube', handle: channel.snippet?.customUrl ?? '', avatarUrl: channel.snippet?.thumbnails?.default?.url ?? '', connectedAt: new Date().toISOString() }
  }
  if (platform === 'twitch') {
    const clientId = process.env.TWITCH_CLIENT_ID ?? ''
    const response = await fetch('https://api.twitch.tv/helix/users', { headers: { authorization: `Bearer ${accessToken}`, 'Client-Id': clientId }, cache: 'no-store', signal: AbortSignal.timeout(10000) })
    const body = await response.json().catch(() => ({})) as { data?: Array<{ id?: string; login?: string; display_name?: string; profile_image_url?: string }> }
    if (!response.ok) throw new Error(`Twitch hesap bilgisi alınamadı (HTTP ${response.status}).`)
    const user = body.data?.[0]
    if (!user?.id || !user.login) throw new Error('Twitch hesabı bilgisi bulunamadı.')
    return { connected: true, userId: user.id, login: user.login, title: user.display_name ?? user.login, avatarUrl: user.profile_image_url ?? '', connectedAt: new Date().toISOString() }
  }
  const userResponse = await fetch('https://api.kick.com/public/v1/users', { headers: { authorization: `Bearer ${accessToken}` }, cache: 'no-store', signal: AbortSignal.timeout(10000) })
  const userBody = await userResponse.json().catch(() => ({})) as { data?: Array<Record<string, unknown>> | Record<string, unknown> }
  if (!userResponse.ok) throw new Error(`Kick hesap bilgisi alınamadı (HTTP ${userResponse.status}).`)
  const data = Array.isArray(userBody.data) ? userBody.data[0] : userBody.data
  const userId = String(data?.user_id ?? data?.id ?? '')
  const username = String(data?.name ?? data?.username ?? data?.channel_slug ?? '')
  if (!userId && !username) throw new Error('Kick hesabı bilgisi bulunamadı.')
  let channelSlug = String(data?.channel_slug ?? username)
  if (userId) {
    const channelResponse = await fetch(`https://api.kick.com/public/v1/channels?broadcaster_user_id=${encodeURIComponent(userId)}`, { headers: { authorization: `Bearer ${accessToken}` }, cache: 'no-store', signal: AbortSignal.timeout(10000) })
    if (channelResponse.ok) {
      const channelBody = await channelResponse.json().catch(() => ({})) as { data?: Array<Record<string, unknown>> }
      channelSlug = String(channelBody.data?.[0]?.slug ?? channelSlug)
    }
  }
  return { connected: true, userId, username, channelSlug, title: username || channelSlug || 'Kick', connectedAt: new Date().toISOString() }
}

function redirectBack(request: NextRequest, serverId: string, platform: string, ok: boolean, message = '') {
  const url = new URL(`/servers/${serverId}`, appBaseUrl(request))
  url.searchParams.set('section', 'integrations')
  url.searchParams.set('streamPlatform', platform)
  url.searchParams.set('oauth', ok ? 'success' : 'error')
  if (message) url.searchParams.set('message', message.slice(0, 180))
  return NextResponse.redirect(url)
}

export async function GET(request: NextRequest) {
  await ensurePanelSchema()
  const stateValue = request.nextUrl.searchParams.get('state') ?? ''
  const code = request.nextUrl.searchParams.get('code') ?? ''
  const providerError = request.nextUrl.searchParams.get('error') ?? ''
  if (!stateValue) return NextResponse.json({ error: 'OAuth state eksik' }, { status: 400 })
  const state = await consumeIntegrationOauthState(stateValue)
  if (!state) return NextResponse.json({ error: 'OAuth state geçersiz veya süresi dolmuş' }, { status: 400 })
  if (providerError || !code) return redirectBack(request, state.serverId, state.platform, false, providerError || 'Yetkilendirme iptal edildi')
  if (!integrationEncryptionReady()) return redirectBack(request, state.serverId, state.platform, false, 'INTEGRATION_ENCRYPTION_KEY eksik')

  try {
    const callbackUrl = `${appBaseUrl(request)}/api/integrations/oauth/callback`
    const token = await exchangeToken(state.platform, code, callbackUrl, state.codeVerifier)
    const account = await fetchAccount(state.platform, token.accessToken)
    const existing = await getIntegration(state.serverId, 'live-stream')
    const existingSecret = existing ? decryptIntegrationSecret(existing) ?? {} : {}
    const secret = {
      ...existingSecret,
      [`${state.platform}AccessToken`]: token.accessToken,
      [`${state.platform}RefreshToken`]: token.refreshToken,
      [`${state.platform}ExpiresAt`]: token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : '',
    }
    const config = {
      ...(existing?.config ?? {}),
      sourceMode: 'account',
      platform: state.platform,
      recording: false,
      storageMode: 'none',
      framePersistence: false,
      transport: 'platform-embed',
      [`${state.platform}Account`]: account,
    }
    await upsertIntegration({ serverId: state.serverId, kind: 'live-stream', userId: state.userId, enabled: existing?.enabled ?? false, status: 'configured', config, secret, preserveSecret: false, lastError: null })
    await writeIntegrationLog(state.serverId, 'live-stream', 'account.connected', { platform: state.platform, account: String((account as Record<string, unknown>).title ?? '') })
    await db.insert(auditLog).values({ userId: state.userId, action: 'integration.live-stream.account-connect', resourceType: 'server-integration', resourceId: state.serverId, details: { platform: state.platform } })
    return redirectBack(request, state.serverId, state.platform, true)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Hesap bağlantısı başarısız'
    await writeIntegrationLog(state.serverId, 'live-stream', 'account.connect.failed', { platform: state.platform, error: message }, 'error').catch(() => {})
    return redirectBack(request, state.serverId, state.platform, false, message)
  }
}
