import { createHash, randomBytes } from 'node:crypto'
import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db, ensurePanelSchema } from '@/lib/db'
import { serverPermissions, servers } from '@/lib/db/schema'
import { resolvePanelUser } from '@/lib/db/identity'
import { createIntegrationOauthState, integrationEncryptionReady, type StreamPlatform } from '@/lib/integrations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function appBaseUrl(request: NextRequest) {
  return (process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL ?? request.nextUrl.origin).replace(/\/$/, '')
}

async function currentActor() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return null
  return resolvePanelUser(session.user)
}

async function authorized(actor: NonNullable<Awaited<ReturnType<typeof currentActor>>>, serverId: string) {
  const server = (await db.select().from(servers).where(eq(servers.id, serverId)).limit(1))[0]
  if (!server || server.status === 'deleted') return false
  if (actor.role === 'manager') return true
  const permission = (await db.select().from(serverPermissions).where(and(eq(serverPermissions.serverId, serverId), eq(serverPermissions.userId, actor.id))).limit(1))[0]
  const sections = Array.isArray(permission?.sections) ? permission.sections.map(String) : []
  return !!permission?.canReset && sections.includes('integrations')
}

function platformConfig(platform: StreamPlatform) {
  if (platform === 'youtube') return {
    clientId: process.env.YOUTUBE_CLIENT_ID ?? '',
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET ?? '',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    scope: 'https://www.googleapis.com/auth/youtube.readonly',
  }
  if (platform === 'twitch') return {
    clientId: process.env.TWITCH_CLIENT_ID ?? '',
    clientSecret: process.env.TWITCH_CLIENT_SECRET ?? '',
    authorize: 'https://id.twitch.tv/oauth2/authorize',
    scope: 'user:read:email',
  }
  return {
    clientId: process.env.KICK_CLIENT_ID ?? '',
    clientSecret: process.env.KICK_CLIENT_SECRET ?? '',
    authorize: 'https://id.kick.com/oauth/authorize',
    scope: 'user:read channel:read',
  }
}

export async function GET(request: NextRequest) {
  await ensurePanelSchema()
  const actor = await currentActor()
  if (!actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!actor.approved) return NextResponse.json({ error: 'Approval required' }, { status: 403 })
  if (!integrationEncryptionReady()) return NextResponse.json({ error: 'Hesap tokenlarını güvenli saklamak için INTEGRATION_ENCRYPTION_KEY gerekli.' }, { status: 409 })
  const serverId = request.nextUrl.searchParams.get('serverId') ?? ''
  const rawPlatform = request.nextUrl.searchParams.get('platform') ?? ''
  if (!['youtube','twitch','kick'].includes(rawPlatform)) return NextResponse.json({ error: 'Geçersiz yayın platformu' }, { status: 400 })
  const platform = rawPlatform as StreamPlatform
  if (!(await authorized(actor, serverId))) return NextResponse.json({ error: 'Entegrasyon hesabı bağlama yetkiniz yok' }, { status: 403 })

  const cfg = platformConfig(platform)
  if (!cfg.clientId || !cfg.clientSecret) return NextResponse.json({ error: `${platform.toUpperCase()} OAuth istemci bilgileri Vercel ortamında yapılandırılmamış.` }, { status: 409 })

  const callbackUrl = `${appBaseUrl(request)}/api/integrations/oauth/callback`
  const state = randomBytes(32).toString('base64url')
  const codeVerifier = platform === 'kick' ? randomBytes(48).toString('base64url') : null
  await createIntegrationOauthState({ state, serverId, userId: actor.id, platform, codeVerifier, expiresAt: new Date(Date.now() + 10 * 60_000) })

  const url = new URL(cfg.authorize)
  url.searchParams.set('client_id', cfg.clientId)
  url.searchParams.set('redirect_uri', callbackUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', cfg.scope)
  url.searchParams.set('state', state)
  if (platform === 'youtube') {
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('prompt', 'consent')
  }
  if (platform === 'twitch') url.searchParams.set('force_verify', 'true')
  if (platform === 'kick' && codeVerifier) {
    url.searchParams.set('code_challenge', createHash('sha256').update(codeVerifier).digest('base64url'))
    url.searchParams.set('code_challenge_method', 'S256')
  }
  return NextResponse.redirect(url)
}
