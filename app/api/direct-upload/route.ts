import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { and, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db, ensurePanelSchema } from '@/lib/db'
import { agentCommands, serverPermissions, servers, uploadSessions } from '@/lib/db/schema'
import { resolvePanelUser } from '@/lib/db/identity'
import { nodeFetch, nodeDiagnosticMessage } from '@/lib/node-bridge'

export const runtime = 'nodejs'
export const maxDuration = 300

const CHUNK_SIZE = 3 * 1024 * 1024
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024
const allowedCategories = new Set(['mods', 'plugins', 'configs', 'resource-packs', 'worlds', 'auto'])

async function currentActor() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return null
  return resolvePanelUser(session.user)
}

async function authorizedServer(actor: NonNullable<Awaited<ReturnType<typeof currentActor>>>, serverId: string, category = 'auto') {
  const server = (await db.select().from(servers).where(eq(servers.id, serverId)).limit(1))[0]
  if (!server) return null
  if (actor.role === 'manager') return server
  const permission = (await db.select().from(serverPermissions).where(and(eq(serverPermissions.serverId, serverId), eq(serverPermissions.userId, actor.id))).limit(1))[0]
  const allowed = category === 'worlds' ? permission?.canFiles || permission?.canReset : permission?.canFiles
  return allowed ? server : null
}

function safeFilename(value: string) {
  const base = value.replace(/\\/g, '/').split('/').pop() ?? 'uploaded-file'
  return base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180) || 'uploaded-file'
}

async function getAuthorizedCommand(actor: NonNullable<Awaited<ReturnType<typeof currentActor>>>, commandId: string) {
  const command = (await db.select().from(agentCommands).where(eq(agentCommands.id, commandId)).limit(1))[0]
  if (!command?.serverId) return null
  const payload = (command.payload ?? {}) as Record<string, unknown>
  const server = await authorizedServer(actor, command.serverId, String(payload.category ?? 'auto'))
  return server ? command : null
}

async function failCommand(commandId: string, message: string) {
  await db.update(agentCommands).set({ status: 'failed', result: { error: message }, completedAt: new Date() }).where(eq(agentCommands.id, commandId))
}

export async function POST(request: NextRequest) {
  await ensurePanelSchema()
  const actor = await currentActor()
  if (!actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!actor.approved) return NextResponse.json({ error: 'Approval required' }, { status: 403 })

  const body = await request.json() as Record<string, unknown>
  const action = String(body.action ?? 'start')

  if (action === 'start') {
    const serverId = String(body.serverId ?? '')
    const filename = safeFilename(String(body.filename ?? 'uploaded-file'))
    const size = Number(body.size ?? 0)
    const category = String(body.category ?? 'auto')
    if (!serverId || !Number.isFinite(size) || size <= 0 || size > MAX_FILE_SIZE || !allowedCategories.has(category)) {
      return NextResponse.json({ error: 'Geçersiz yükleme isteği veya dosya 2 GB sınırını aşıyor' }, { status: 400 })
    }
    const server = await authorizedServer(actor, serverId, category)
    if (!server) return NextResponse.json({ error: 'Sunucu bulunamadı' }, { status: 404 })
    if (!['stopped', 'crashed', 'ready', 'failed'].includes(server.status)) return NextResponse.json({ error: 'Dosya yüklemek için sunucuyu durdurun' }, { status: 409 })

    const uploadId = crypto.randomUUID()
    const totalParts = Math.ceil(size / CHUNK_SIZE)
    const type = filename.toLowerCase().endsWith('.zip') ? 'upload-archive' : 'upload-file'
    const payload = { direct: true, uploadId, filename, category, size, totalParts, chunkSize: CHUNK_SIZE }
    const inserted = await db.insert(agentCommands).values({ userId: server.userId, nodeId: server.nodeId, serverId, type, payload, status: 'processing' }).returning({ id: agentCommands.id })
    const commandId = inserted[0]?.id
    if (!commandId) return NextResponse.json({ error: 'Yükleme kaydı oluşturulamadı' }, { status: 500 })
    await db.insert(uploadSessions).values({uploadId,commandId,userId:actor.id,serverId,nodeId:server.nodeId,filename,totalSize:size,chunkSize:CHUNK_SIZE,totalParts,status:'starting'}).onConflictDoNothing()

    try {
      const response = await nodeFetch(server.nodeId, '/internal/uploads/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uploadId, commandId, serverId, filename, category, size, totalParts, chunkSize: CHUNK_SIZE }),
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`Agent upload başlangıcı başarısız (${response.status}): ${(await response.text()).slice(0, 240)}`)
      return NextResponse.json({ uploadId, commandId, chunkSize: CHUNK_SIZE, totalParts, maxFileSize: MAX_FILE_SIZE })
    } catch (error) {
      const message = nodeDiagnosticMessage(error)
      await failCommand(commandId, message)
      return NextResponse.json({ error: message }, { status: 502 })
    }
  }

  if (action === 'complete') {
    const commandId = String(body.commandId ?? '')
    const uploadId = String(body.uploadId ?? '')
    const command = await getAuthorizedCommand(actor, commandId)
    if (!command) return NextResponse.json({ error: 'Yükleme kaydı bulunamadı' }, { status: 404 })
    const payload = (command.payload ?? {}) as Record<string, unknown>
    if (command.status !== 'processing' || String(payload.uploadId ?? '') !== uploadId) return NextResponse.json({ error: 'Geçersiz veya tamamlanmış yükleme' }, { status: 409 })
    try {
      const response = await nodeFetch(command.nodeId, `/internal/uploads/${encodeURIComponent(uploadId)}/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commandId }),
        cache: 'no-store',
      })
      const text = await response.text()
      let result: unknown = {}
      try { result = text ? JSON.parse(text) : {} } catch { result = { message: text } }
      if (!response.ok) { if (response.status === 409) return NextResponse.json({error:'Eksik parçalar var. Eksik parçaları yeniden göndererek devam edin.',code:'UPLOAD_PARTS_MISSING',details:result},{status:409}); throw new Error(`Agent yüklemeyi tamamlayamadı (${response.status}): ${text.slice(0, 240)}`) }
      await db.update(uploadSessions).set({status:'completed',completedAt:new Date(),lastActivityAt:new Date()}).where(eq(uploadSessions.uploadId,uploadId))
      return NextResponse.json({ ok: true, result })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Yükleme tamamlanamadı'
      await failCommand(commandId, message)
      return NextResponse.json({ error: message }, { status: 502 })
    }
  }

  return NextResponse.json({ error: 'Geçersiz action' }, { status: 400 })
}

export async function GET(request: NextRequest) {
  await ensurePanelSchema()
  const actor = await currentActor()
  if (!actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const commandId = request.nextUrl.searchParams.get('commandId') ?? ''
  const uploadId = request.nextUrl.searchParams.get('uploadId') ?? ''
  const command = await getAuthorizedCommand(actor, commandId)
  if (!command) return NextResponse.json({ error: 'UPLOAD_SESSION_NOT_FOUND', code: 'UPLOAD_SESSION_NOT_FOUND' }, { status: 404 })
  const payload = (command.payload ?? {}) as Record<string, unknown>
  if (String(payload.uploadId ?? '') !== uploadId) return NextResponse.json({ error: 'UPLOAD_ID_MISMATCH', code: 'UPLOAD_ID_MISMATCH' }, { status: 409 })
  const totalParts = Number(payload.totalParts ?? 0)
  const receivedPart = Number(payload.receivedPart ?? -1)
  try {
    const response = await nodeFetch(command.nodeId, `/internal/uploads/${encodeURIComponent(uploadId)}/status`, { method: 'GET', cache: 'no-store' })
    const text = await response.text(); let result: Record<string, unknown> = {}
    try { result = text ? JSON.parse(text) as Record<string, unknown> : {} } catch {}
    if (!response.ok) return NextResponse.json({ error: 'UPLOAD_SESSION_NOT_FOUND', code: 'UPLOAD_SESSION_NOT_FOUND' }, { status: 404 })
    return NextResponse.json({ ...result, status: command.status })
  } catch { return NextResponse.json({ receivedParts: Number.isInteger(receivedPart) && receivedPart >= 0 ? [receivedPart] : [], totalParts, status: command.status }) }
}

export async function PUT(request: NextRequest) {
  await ensurePanelSchema()
  const actor = await currentActor()
  if (!actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!actor.approved) return NextResponse.json({ error: 'Approval required' }, { status: 403 })
  const commandId = request.nextUrl.searchParams.get('commandId') ?? ''
  const uploadId = request.nextUrl.searchParams.get('uploadId') ?? ''
  const part = Number(request.nextUrl.searchParams.get('part') ?? '-1')
  const command = await getAuthorizedCommand(actor, commandId)
  if (!command) return NextResponse.json({ error: 'Yükleme kaydı bulunamadı' }, { status: 404 })
  const payload = (command.payload ?? {}) as Record<string, unknown>
  const totalParts = Number(payload.totalParts ?? 0)
  if (String(payload.uploadId ?? '') !== uploadId) return NextResponse.json({ error: 'UPLOAD_ID_MISMATCH', code: 'UPLOAD_ID_MISMATCH' }, { status: 409 })
  if (!Number.isInteger(part) || part < 0 || part >= totalParts) return NextResponse.json({ error: 'INVALID_PART_NUMBER', code: 'INVALID_PART_NUMBER' }, { status: 400 })
  if (command.status === 'completed') return NextResponse.json({ error: 'UPLOAD_ALREADY_COMPLETED', code: 'UPLOAD_ALREADY_COMPLETED' }, { status: 409 })
  if (command.status !== 'processing') return NextResponse.json({ error: command.status === 'failed' ? 'UPLOAD_COMMAND_EXPIRED' : 'UPLOAD_SESSION_NOT_FOUND', code: command.status === 'failed' ? 'UPLOAD_COMMAND_EXPIRED' : 'UPLOAD_SESSION_NOT_FOUND' }, { status: 409 })

  const announced = Number(request.headers.get('content-length') ?? 0)
  if (announced > CHUNK_SIZE) return NextResponse.json({ error: 'Parça boyutu çok büyük' }, { status: 413 })
  const chunk = Buffer.from(await request.arrayBuffer())
  if (!chunk.length || chunk.length > CHUNK_SIZE) return NextResponse.json({ error: 'Geçersiz parça boyutu' }, { status: 400 })

  try {
    const response = await nodeFetch(command.nodeId, `/internal/uploads/${encodeURIComponent(uploadId)}/${part}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: chunk,
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`Agent parça yüklemesini reddetti (${response.status}): ${(await response.text()).slice(0, 240)}`)
    await db.update(agentCommands).set({ payload: { ...payload, lastActivityAt: new Date().toISOString(), receivedPart: part } }).where(eq(agentCommands.id, command.id))
    await db.update(uploadSessions).set({status:'uploading',lastActivityAt:new Date(),receivedParts:[part],receivedBytes:chunk.length}).where(eq(uploadSessions.uploadId,uploadId))
    return NextResponse.json({ ok: true, part })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Parça gönderilemedi'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
