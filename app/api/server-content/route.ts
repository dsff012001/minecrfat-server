import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db, ensurePanelSchema } from '@/lib/db'
import { auditLog, serverPermissions, servers } from '@/lib/db/schema'
import { resolvePanelUser } from '@/lib/db/identity'
import { nodeDiagnosticMessage, nodeFetch } from '@/lib/node-bridge'

export const runtime = 'nodejs'
export const maxDuration = 60

const MAX_TEXT_SIZE = 2_000_000

async function currentActor() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return null
  return resolvePanelUser(session.user)
}

async function authorizedServer(actor: NonNullable<Awaited<ReturnType<typeof currentActor>>>, serverId: string) {
  const server = (await db.select().from(servers).where(eq(servers.id, serverId)).limit(1))[0]
  if (!server) return null
  if (actor.role === 'manager') return server
  const permission = (await db.select().from(serverPermissions).where(and(eq(serverPermissions.serverId, serverId), eq(serverPermissions.userId, actor.id))).limit(1))[0]
  return permission?.canFiles ? server : null
}

function safeRelativePath(value: unknown) {
  const path = String(value ?? '').replace(/\\/g, '/').trim()
  if (!path || path.startsWith('/') || path.includes('\0') || path.split('/').some(part => part === '..')) return null
  return path.split('/').filter(part => part && part !== '.').join('/')
}

async function nodeJson(nodeId: string, path: string, init: RequestInit = {}) {
  const response = await nodeFetch(nodeId, path, init)
  const text = await response.text()
  let data: Record<string, unknown> = {}
  try { data = text ? JSON.parse(text) as Record<string, unknown> : {} } catch { data = { error: text.slice(0, 500) } }
  if (!response.ok) throw new Error(String(data.error ?? `Node içerik işlemi başarısız (${response.status})`))
  return data
}

export async function GET(request: NextRequest) {
  await ensurePanelSchema()
  const actor = await currentActor()
  if (!actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!actor.approved) return NextResponse.json({ error: 'Approval required' }, { status: 403 })
  const serverId = request.nextUrl.searchParams.get('serverId') ?? ''
  const server = await authorizedServer(actor, serverId)
  if (!server) return NextResponse.json({ error: 'Sunucu bulunamadı veya dosya izniniz yok' }, { status: 404 })
  const requestedPath = request.nextUrl.searchParams.get('path')
  try {
    if (requestedPath) {
      const path = safeRelativePath(requestedPath)
      if (!path) return NextResponse.json({ error: 'Geçersiz dosya yolu' }, { status: 400 })
      const data = await nodeJson(server.nodeId, `/internal/content/read?serverId=${encodeURIComponent(server.id)}&path=${encodeURIComponent(path)}`)
      return NextResponse.json(data)
    }
    const data = await nodeJson(server.nodeId, `/internal/content/inventory?serverId=${encodeURIComponent(server.id)}`)
    return NextResponse.json({ ...data, serverRunning: server.status === 'running' })
  } catch (error) {
    return NextResponse.json({ error: nodeDiagnosticMessage(error), items: [] }, { status: 502 })
  }
}

export async function PATCH(request: NextRequest) {
  await ensurePanelSchema()
  const actor = await currentActor()
  if (!actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!actor.approved) return NextResponse.json({ error: 'Approval required' }, { status: 403 })
  const body = await request.json() as { serverId?: string; path?: string; content?: unknown }
  const server = body.serverId ? await authorizedServer(actor, body.serverId) : null
  if (!server) return NextResponse.json({ error: 'Sunucu bulunamadı veya dosya izniniz yok' }, { status: 404 })
  if (server.status === 'running') return NextResponse.json({ error: 'Plugin/config düzenlemek için sunucuyu durdurun' }, { status: 409 })
  const path = safeRelativePath(body.path)
  if (!path || typeof body.content !== 'string' || Buffer.byteLength(body.content, 'utf8') > MAX_TEXT_SIZE) {
    return NextResponse.json({ error: 'Geçersiz dosya düzenleme isteği veya dosya 2 MB sınırını aşıyor' }, { status: 400 })
  }
  try {
    const data = await nodeJson(server.nodeId, '/internal/content/write', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serverId: server.id, path, content: body.content }), cache: 'no-store',
    })
    await db.insert(auditLog).values({ userId: actor.id, action: 'content.write', resourceType: 'server', resourceId: server.id, details: { path } })
    return NextResponse.json(data)
  } catch (error) {
    return NextResponse.json({ error: nodeDiagnosticMessage(error) }, { status: 502 })
  }
}

export async function DELETE(request: NextRequest) {
  await ensurePanelSchema()
  const actor = await currentActor()
  if (!actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!actor.approved) return NextResponse.json({ error: 'Approval required' }, { status: 403 })
  const body = await request.json() as { serverId?: string; path?: string; confirm?: boolean }
  const server = body.serverId ? await authorizedServer(actor, body.serverId) : null
  if (!server) return NextResponse.json({ error: 'Sunucu bulunamadı veya dosya izniniz yok' }, { status: 404 })
  if (server.status === 'running') return NextResponse.json({ error: 'İçerik silmek için sunucuyu durdurun' }, { status: 409 })
  const path = safeRelativePath(body.path)
  if (!path || body.confirm !== true) return NextResponse.json({ error: 'Silme işlemi için geçerli yol ve onay gerekli' }, { status: 400 })
  try {
    const data = await nodeJson(server.nodeId, '/internal/content/delete', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serverId: server.id, path }), cache: 'no-store',
    })
    await db.insert(auditLog).values({ userId: actor.id, action: 'content.delete', resourceType: 'server', resourceId: server.id, details: { path } })
    return NextResponse.json(data)
  } catch (error) {
    return NextResponse.json({ error: nodeDiagnosticMessage(error) }, { status: 502 })
  }
}
