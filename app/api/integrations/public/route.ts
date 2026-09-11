import { createHash, timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db, ensurePanelSchema } from '@/lib/db'
import { nodes, serverSettings, servers } from '@/lib/db/schema'
import { ensureIntegrationSchema, getIntegration } from '@/lib/integrations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

function hash(value: string) { return createHash('sha256').update(value).digest('hex') }

function safeEqualHex(actual: string, expected: string) {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function apiKeyFromRequest(request: NextRequest) {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  return bearer || request.headers.get('x-blockctrl-api-key')?.trim() || ''
}

function corsHeaders(origin: string | null, allowedOrigins: string[]) {
  const headers: Record<string, string> = {
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Authorization, X-BlockCtrl-Api-Key, Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  }
  if (origin && allowedOrigins.includes(origin)) headers['Access-Control-Allow-Origin'] = origin
  return headers
}

export async function OPTIONS(request: NextRequest) {
  try {
    await ensureIntegrationSchema()
    const serverId = request.nextUrl.searchParams.get('serverId') ?? ''
    const row = serverId ? await getIntegration(serverId, 'web-api') : null
    const allowedOrigins = Array.isArray(row?.config.allowedOrigins) ? row!.config.allowedOrigins.map(String) : []
    const origin = request.headers.get('origin')
    if (origin && allowedOrigins.length && !allowedOrigins.includes(origin)) return new NextResponse(null, { status: 403, headers: corsHeaders(null, allowedOrigins) })
    return new NextResponse(null, { status: 204, headers: corsHeaders(origin, allowedOrigins) })
  } catch {
    return new NextResponse(null, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  try {
    await ensurePanelSchema()
    await ensureIntegrationSchema()
    const serverId = request.nextUrl.searchParams.get('serverId') ?? ''
    if (!/^[0-9a-f-]{36}$/i.test(serverId)) return NextResponse.json({ error: 'Geçersiz serverId' }, { status: 400 })
    const integration = await getIntegration(serverId, 'web-api')
    if (!integration?.enabled || !integration.config.apiKeyHash) return NextResponse.json({ error: 'Web API aktif değil' }, { status: 404 })
    const suppliedKey = apiKeyFromRequest(request)
    if (!suppliedKey || !safeEqualHex(hash(suppliedKey), String(integration.config.apiKeyHash))) return NextResponse.json({ error: 'Geçersiz API anahtarı' }, { status: 401 })

    const allowedOrigins = Array.isArray(integration.config.allowedOrigins) ? integration.config.allowedOrigins.map(String) : []
    const origin = request.headers.get('origin')
    if (origin && allowedOrigins.length && !allowedOrigins.includes(origin)) return NextResponse.json({ error: 'Bu origin izin listesinde değil' }, { status: 403, headers: corsHeaders(null, allowedOrigins) })

    const server = (await db.select().from(servers).where(eq(servers.id, serverId)).limit(1))[0]
    if (!server || server.status === 'deleted') return NextResponse.json({ error: 'Sunucu bulunamadı' }, { status: 404 })
    const node = (await db.select().from(nodes).where(eq(nodes.id, server.nodeId)).limit(1))[0]
    const settings = (await db.select().from(serverSettings).where(eq(serverSettings.serverId, serverId)).limit(1))[0]
    const maxPlayersRaw = settings?.settings && typeof settings.settings === 'object' ? (settings.settings as Record<string, unknown>).maxPlayers : undefined
    const maxPlayers = Number.isFinite(Number(maxPlayersRaw)) ? Number(maxPlayersRaw) : null
    const heartbeatFresh = !!node?.lastHeartbeat && Date.now() - new Date(node.lastHeartbeat).getTime() < 90_000

    return NextResponse.json({
      server: {
        id: server.id,
        name: server.name,
        status: server.status,
        online: server.status === 'running',
        loader: server.loader,
        minecraftVersion: server.mcVersion,
        playerCount: server.playerCount,
        maxPlayers,
        port: server.port,
      },
      metrics: node ? {
        nodeOnline: node.status === 'online' && heartbeatFresh,
        cpuPercent: node.cpuPercent,
        memoryUsedMb: node.memoryUsedMb,
        memoryTotalMb: node.memoryTotalMb,
        diskUsedGb: node.diskUsedGb,
        diskTotalGb: node.diskTotalGb,
        lastHeartbeat: node.lastHeartbeat,
      } : null,
      availability: {
        activePlayers: false,
        uptime: false,
        tps: false,
        ping: false,
        websocket: false,
      },
      generatedAt: new Date().toISOString(),
    }, { headers: corsHeaders(origin, allowedOrigins) })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Web API isteği başarısız'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
