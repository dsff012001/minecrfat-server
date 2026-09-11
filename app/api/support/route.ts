import { randomUUID } from 'node:crypto'
import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { get } from '@vercel/blob'
import { auth } from '@/lib/auth'
import { ensurePanelSchema, pool } from '@/lib/db'
import { resolvePanelUser } from '@/lib/db/identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SUPPORT_RULES_VERSION = '2026-09-10-v1'
const STAFF_ROLES = new Set(['manager', 'admin', 'guide'])
const THREAD_TYPES = new Set(['support', 'bug', 'private'])
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent'])
const ALLOWED_ATTACHMENT_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v',
])
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
const MAX_ATTACHMENTS_PER_MESSAGE = 6

function normalizedRole(role: unknown) {
  const value = String(role ?? '').toLowerCase()
  if (value === 'manager' || value === 'admin' || value === 'guide' || value === 'member') return value
  return 'member'
}
function isStaff(role: unknown) { return STAFF_ROLES.has(normalizedRole(role)) }
function cleanText(value: unknown, max: number) { return String(value ?? '').trim().slice(0, max) }
function bool(value: unknown) { return value === true }

async function currentActor() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return null
  return resolvePanelUser(session.user)
}

async function consentAccepted(userId: string) {
  const result = await pool.query<{ version: string }>(`SELECT version FROM support_consents WHERE "userId"=$1 LIMIT 1`, [userId])
  return result.rows[0]?.version === SUPPORT_RULES_VERSION
}

async function requireConsent(actor: NonNullable<Awaited<ReturnType<typeof currentActor>>>) {
  if (isStaff(actor.role)) return true
  return consentAccepted(actor.id)
}

type ThreadRow = {
  id: string
  type: string
  status: string
  subject: string
  priority: string
  creatorUserId: string
  targetUserId: string | null
  assignedUserId: string | null
  createdByRole: string
  acceptedAt: Date | null
  closedAt: Date | null
  closedBy: string | null
  lastMessageAt: Date
  createdAt: Date
  updatedAt: Date
  creatorName?: string | null
  creatorRole?: string | null
  targetName?: string | null
  targetRole?: string | null
  assignedName?: string | null
  assignedRole?: string | null
}

async function threadById(id: string) {
  const result = await pool.query<ThreadRow>(`
    SELECT t.*,
      creator.name AS "creatorName", creator.role AS "creatorRole",
      target.name AS "targetName", target.role AS "targetRole",
      assigned.name AS "assignedName", assigned.role AS "assignedRole"
    FROM support_threads t
    LEFT JOIN "user" creator ON creator.id=t."creatorUserId"
    LEFT JOIN "user" target ON target.id=t."targetUserId"
    LEFT JOIN "user" assigned ON assigned.id=t."assignedUserId"
    WHERE t.id=$1
    LIMIT 1
  `, [id])
  return result.rows[0] ?? null
}

function canReadThread(actor: NonNullable<Awaited<ReturnType<typeof currentActor>>>, thread: ThreadRow) {
  if (thread.type === 'private') return thread.creatorUserId === actor.id || thread.targetUserId === actor.id
  if (isStaff(actor.role)) return true
  return thread.creatorUserId === actor.id
}

function canAcceptThread(actor: NonNullable<Awaited<ReturnType<typeof currentActor>>>, thread: ThreadRow) {
  return isStaff(actor.role) && thread.type !== 'private' && thread.status === 'pending'
}

function canSendMessage(actor: NonNullable<Awaited<ReturnType<typeof currentActor>>>, thread: ThreadRow) {
  if (thread.status !== 'open') return false
  if (thread.type === 'private') return thread.creatorUserId === actor.id || thread.targetUserId === actor.id
  if (thread.creatorUserId === actor.id) return true
  return thread.assignedUserId === actor.id
}

function canCloseThread(actor: NonNullable<Awaited<ReturnType<typeof currentActor>>>, thread: ThreadRow) {
  if (thread.status === 'closed' || thread.status === 'declined') return false
  if (thread.type === 'private') return thread.creatorUserId === actor.id || thread.targetUserId === actor.id
  if (thread.creatorUserId === actor.id || thread.assignedUserId === actor.id) return true
  return normalizedRole(actor.role) === 'manager' || normalizedRole(actor.role) === 'admin'
}

function canRespondPrivateInvite(actor: NonNullable<Awaited<ReturnType<typeof currentActor>>>, thread: ThreadRow) {
  return thread.type === 'private' && thread.status === 'invited' && thread.targetUserId === actor.id
}

async function listThreads(actor: NonNullable<Awaited<ReturnType<typeof currentActor>>>) {
  const staff = isStaff(actor.role)
  const result = staff
    ? await pool.query<ThreadRow>(`
        SELECT t.*,
          creator.name AS "creatorName", creator.role AS "creatorRole",
          target.name AS "targetName", target.role AS "targetRole",
          assigned.name AS "assignedName", assigned.role AS "assignedRole"
        FROM support_threads t
        LEFT JOIN "user" creator ON creator.id=t."creatorUserId"
        LEFT JOIN "user" target ON target.id=t."targetUserId"
        LEFT JOIN "user" assigned ON assigned.id=t."assignedUserId"
        WHERE t.type IN ('support','bug') OR (t.type='private' AND (t."creatorUserId"=$1 OR t."targetUserId"=$1))
        ORDER BY t."lastMessageAt" DESC
        LIMIT 250
      `, [actor.id])
    : await pool.query<ThreadRow>(`
        SELECT t.*,
          creator.name AS "creatorName", creator.role AS "creatorRole",
          target.name AS "targetName", target.role AS "targetRole",
          assigned.name AS "assignedName", assigned.role AS "assignedRole"
        FROM support_threads t
        LEFT JOIN "user" creator ON creator.id=t."creatorUserId"
        LEFT JOIN "user" target ON target.id=t."targetUserId"
        LEFT JOIN "user" assigned ON assigned.id=t."assignedUserId"
        WHERE t."creatorUserId"=$1 OR t."targetUserId"=$1
        ORDER BY t."lastMessageAt" DESC
        LIMIT 250
      `, [actor.id])
  return result.rows
}

async function attachmentResponse(request: NextRequest, actor: NonNullable<Awaited<ReturnType<typeof currentActor>>>, attachmentId: string) {
  const result = await pool.query<{
    id:string; threadId:string; pathname:string; filename:string; contentType:string; sizeBytes:string
  }>(`SELECT id,"threadId",pathname,filename,"contentType","sizeBytes" FROM support_attachments WHERE id=$1 LIMIT 1`, [attachmentId])
  const attachment = result.rows[0]
  if (!attachment) return NextResponse.json({ error: 'Dosya bulunamadı' }, { status: 404 })
  const thread = await threadById(attachment.threadId)
  if (!thread || !canReadThread(actor, thread)) return NextResponse.json({ error: 'Bu dosyaya erişiminiz yok' }, { status: 403 })
  try {
    const blob = await get(attachment.pathname, { access: 'private', useCache: false })
    if (!blob) return NextResponse.json({ error: 'Dosya depolamada bulunamadı' }, { status: 404 })
    const safeName = attachment.filename.replace(/[\r\n"]/g, '_')
    return new Response(blob.stream, {
      status: 200,
      headers: {
        'Content-Type': attachment.contentType || blob.blob.contentType || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${safeName}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return NextResponse.json({ error: 'Dosya okunamadı' }, { status: 502 })
  }
}

async function threadDetail(actor: NonNullable<Awaited<ReturnType<typeof currentActor>>>, threadId: string) {
  const thread = await threadById(threadId)
  if (!thread || !canReadThread(actor, thread)) return NextResponse.json({ error: 'Sohbet bulunamadı' }, { status: 404 })
  const [messageResult, attachmentResult] = await Promise.all([
    pool.query<{
      id:string; threadId:string; senderUserId:string; body:string; createdAt:Date; senderName:string|null; senderRole:string|null
    }>(`
      SELECT m.*, u.name AS "senderName", u.role AS "senderRole"
      FROM support_messages m
      LEFT JOIN "user" u ON u.id=m."senderUserId"
      WHERE m."threadId"=$1
      ORDER BY m."createdAt" ASC
      LIMIT 1000
    `, [threadId]),
    pool.query<{
      id:string; threadId:string; messageId:string; filename:string; contentType:string; sizeBytes:string; createdAt:Date
    }>(`SELECT id,"threadId","messageId",filename,"contentType","sizeBytes","createdAt" FROM support_attachments WHERE "threadId"=$1 ORDER BY "createdAt" ASC`, [threadId]),
  ])
  const attachmentsByMessage = new Map<string, typeof attachmentResult.rows>()
  for (const item of attachmentResult.rows) {
    const current = attachmentsByMessage.get(item.messageId) ?? []
    current.push(item)
    attachmentsByMessage.set(item.messageId, current)
  }
  return NextResponse.json({
    thread,
    messages: messageResult.rows.map(message => ({ ...message, attachments: attachmentsByMessage.get(message.id) ?? [] })),
    permissions: {
      canAccept: canAcceptThread(actor, thread),
      canSend: canSendMessage(actor, thread),
      canClose: canCloseThread(actor, thread),
      canRespondInvite: canRespondPrivateInvite(actor, thread),
    },
  }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function GET(request: NextRequest) {
  await ensurePanelSchema()
  const actor = await currentActor()
  if (!actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!actor.approved) return NextResponse.json({ error: 'Approval required' }, { status: 403 })

  const staff = isStaff(actor.role)
  const accepted = staff || await consentAccepted(actor.id)
  const attachmentId = request.nextUrl.searchParams.get('attachmentId')
  const threadId = request.nextUrl.searchParams.get('threadId')
  if ((attachmentId || threadId) && !accepted) return NextResponse.json({ error: 'Önce destek bilgilendirmesini kabul edin' }, { status: 428 })
  if (attachmentId) return attachmentResponse(request, actor, attachmentId)
  if (threadId) return threadDetail(actor, threadId)

  const threads = await listThreads(actor)
  const [memberResult, staffResult] = staff ? await Promise.all([
    pool.query<{id:string;name:string;role:string}>(`SELECT id,name,role FROM "user" WHERE approved=true AND role='member' ORDER BY name ASC LIMIT 500`),
    pool.query<{id:string;name:string;role:string}>(`SELECT id,name,role FROM "user" WHERE approved=true AND role IN ('manager','admin','guide') ORDER BY name ASC LIMIT 200`),
  ]) : [{ rows: [] as Array<{id:string;name:string;role:string}> }, { rows: [] as Array<{id:string;name:string;role:string}> }]

  const attentionCount = staff
    ? threads.filter(t => t.type !== 'private' && t.status === 'pending').length + threads.filter(t => t.type === 'private' && t.status === 'invited' && t.targetUserId === actor.id).length
    : threads.filter(t => t.type === 'private' && t.status === 'invited' && t.targetUserId === actor.id).length

  return NextResponse.json({
    actor: { id: actor.id, name: actor.name, role: normalizedRole(actor.role) },
    consent: { required: !staff, accepted: staff || accepted, version: SUPPORT_RULES_VERSION },
    threads,
    members: memberResult.rows,
    staff: staffResult.rows,
    attentionCount,
  }, { headers: { 'Cache-Control': 'private, no-store' } })
}

async function insertMessage(threadId: string, senderUserId: string, body: string, attachments: Array<Record<string, unknown>> = []) {
  const messageId = randomUUID()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`INSERT INTO support_messages (id,"threadId","senderUserId",body) VALUES ($1,$2,$3,$4)`, [messageId, threadId, senderUserId, body])
    for (const raw of attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
      const filename = cleanText(raw.filename, 180)
      const pathname = cleanText(raw.pathname, 1000)
      const contentType = cleanText(raw.contentType, 120).toLowerCase()
      const sizeBytes = Number(raw.sizeBytes ?? 0)
      const url = cleanText(raw.url, 2000)
      if (!filename || !pathname.startsWith(`support/${threadId}/`) || !ALLOWED_ATTACHMENT_TYPES.has(contentType) || !Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_ATTACHMENT_BYTES) {
        throw new Error('Geçersiz destek eki')
      }
      await client.query(`INSERT INTO support_attachments (id,"threadId","messageId","uploaderUserId",pathname,url,filename,"contentType","sizeBytes") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [randomUUID(), threadId, messageId, senderUserId, pathname, url, filename, contentType, Math.round(sizeBytes)])
    }
    await client.query(`UPDATE support_threads SET "lastMessageAt"=now(),"updatedAt"=now() WHERE id=$1`, [threadId])
    await client.query('COMMIT')
    return messageId
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export async function POST(request: NextRequest) {
  await ensurePanelSchema()
  const actor = await currentActor()
  if (!actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!actor.approved) return NextResponse.json({ error: 'Approval required' }, { status: 403 })
  const body = await request.json().catch(() => ({})) as Record<string, unknown>
  const action = cleanText(body.action, 60)

  if (action === 'accept-consent') {
    if (isStaff(actor.role)) return NextResponse.json({ ok: true, accepted: true })
    await pool.query(`INSERT INTO support_consents ("userId",version,"acceptedAt") VALUES ($1,$2,now()) ON CONFLICT ("userId") DO UPDATE SET version=EXCLUDED.version,"acceptedAt"=now()`, [actor.id, SUPPORT_RULES_VERSION])
    return NextResponse.json({ ok: true, accepted: true, version: SUPPORT_RULES_VERSION })
  }

  if (!await requireConsent(actor)) return NextResponse.json({ error: 'Destek ve sohbet sistemini kullanmadan önce bilgilendirmeyi okuyup kabul etmelisiniz.' }, { status: 428 })

  if (action === 'create-thread') {
    if (normalizedRole(actor.role) !== 'member') return NextResponse.json({ error: 'Destek ve hata taleplerini üye hesabı oluşturur.' }, { status: 403 })
    const type = cleanText(body.type, 20)
    if (type !== 'support' && type !== 'bug') return NextResponse.json({ error: 'Geçersiz talep türü' }, { status: 400 })
    const subject = cleanText(body.subject, 120)
    const message = cleanText(body.message, 5000)
    const priority = PRIORITIES.has(cleanText(body.priority, 20)) ? cleanText(body.priority, 20) : 'normal'
    if (subject.length < 3 || message.length < 3) return NextResponse.json({ error: 'Konu ve açıklama en az 3 karakter olmalı' }, { status: 400 })
    const threadId = randomUUID()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`INSERT INTO support_threads (id,type,status,subject,priority,"creatorUserId","createdByRole") VALUES ($1,$2,'pending',$3,$4,$5,$6)`, [threadId, type, subject, priority, actor.id, normalizedRole(actor.role)])
      await client.query(`INSERT INTO support_messages (id,"threadId","senderUserId",body) VALUES ($1,$2,$3,$4)`, [randomUUID(), threadId, actor.id, message])
      await client.query(`UPDATE support_threads SET "lastMessageAt"=now() WHERE id=$1`, [threadId])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
    return NextResponse.json({ ok: true, threadId, status: 'pending' }, { status: 201 })
  }

  if (action === 'invite-private') {
    if (!isStaff(actor.role)) return NextResponse.json({ error: 'Yalnız destek yetkilileri özel görüşme başlatabilir' }, { status: 403 })
    const targetUserId = cleanText(body.targetUserId, 200)
    const subject = cleanText(body.subject, 120) || 'Özel görüşme'
    const message = cleanText(body.message, 5000)
    const target = await pool.query<{id:string;role:string;approved:boolean}>(`SELECT id,role,approved FROM "user" WHERE id=$1 LIMIT 1`, [targetUserId])
    if (!target.rows[0] || !target.rows[0].approved || normalizedRole(target.rows[0].role) !== 'member') return NextResponse.json({ error: 'Onaylı üye bulunamadı' }, { status: 404 })
    if (targetUserId === actor.id) return NextResponse.json({ error: 'Kendinizle özel sohbet başlatamazsınız' }, { status: 400 })
    const threadId = randomUUID()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`INSERT INTO support_threads (id,type,status,subject,priority,"creatorUserId","targetUserId","assignedUserId","createdByRole") VALUES ($1,'private','invited',$2,'normal',$3,$4,$3,$5)`, [threadId, subject, actor.id, targetUserId, normalizedRole(actor.role)])
      if (message) await client.query(`INSERT INTO support_messages (id,"threadId","senderUserId",body) VALUES ($1,$2,$3,$4)`, [randomUUID(), threadId, actor.id, message])
      await client.query(`UPDATE support_threads SET "lastMessageAt"=now() WHERE id=$1`, [threadId])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
    return NextResponse.json({ ok: true, threadId, status: 'invited' }, { status: 201 })
  }

  const threadId = cleanText(body.threadId, 100)
  if (!threadId) return NextResponse.json({ error: 'Sohbet kimliği gerekli' }, { status: 400 })
  const thread = await threadById(threadId)
  if (!thread || !canReadThread(actor, thread)) return NextResponse.json({ error: 'Sohbet bulunamadı' }, { status: 404 })

  if (action === 'accept-thread') {
    if (!canAcceptThread(actor, thread)) return NextResponse.json({ error: 'Bu talebi kabul etme yetkiniz yok veya talep artık beklemiyor' }, { status: 403 })
    const updated = await pool.query(`UPDATE support_threads SET status='open',"assignedUserId"=$2,"acceptedAt"=now(),"updatedAt"=now() WHERE id=$1 AND status='pending' RETURNING id`, [threadId, actor.id])
    if (!updated.rowCount) return NextResponse.json({ error: 'Talep başka bir yetkili tarafından alınmış olabilir' }, { status: 409 })
    await insertMessage(threadId, actor.id, `Destek talebi ${actor.name} tarafından kabul edildi.`)
    return NextResponse.json({ ok: true, status: 'open' })
  }

  if (action === 'respond-invite') {
    if (!canRespondPrivateInvite(actor, thread)) return NextResponse.json({ error: 'Bu özel sohbet davetine yanıt veremezsiniz' }, { status: 403 })
    const accept = bool(body.accept)
    if (accept) {
      await pool.query(`UPDATE support_threads SET status='open',"acceptedAt"=now(),"updatedAt"=now() WHERE id=$1 AND status='invited'`, [threadId])
      await insertMessage(threadId, actor.id, `${actor.name} özel sohbet davetini kabul etti.`)
      return NextResponse.json({ ok: true, status: 'open' })
    }
    await pool.query(`UPDATE support_threads SET status='declined',"closedAt"=now(),"closedBy"=$2,"updatedAt"=now() WHERE id=$1 AND status='invited'`, [threadId, actor.id])
    return NextResponse.json({ ok: true, status: 'declined' })
  }

  if (action === 'send-message') {
    const message = cleanText(body.message, 5000)
    const attachments = Array.isArray(body.attachments) ? body.attachments.filter(v => v && typeof v === 'object').slice(0, MAX_ATTACHMENTS_PER_MESSAGE) as Array<Record<string, unknown>> : []
    const evidenceOnly = bool(body.evidenceOnly)
    const pendingEvidenceAllowed = evidenceOnly && thread.status === 'pending' && thread.creatorUserId === actor.id && !message && attachments.length > 0
    if (!canSendMessage(actor, thread) && !pendingEvidenceAllowed) return NextResponse.json({ error: thread.status === 'pending' ? 'Sohbet, destek yetkilisi talebi kabul ettikten sonra açılır.' : 'Bu sohbete mesaj gönderemezsiniz.' }, { status: 403 })
    if (!message && !attachments.length) return NextResponse.json({ error: 'Mesaj veya dosya ekleyin' }, { status: 400 })
    if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) return NextResponse.json({ error: `Bir mesajda en fazla ${MAX_ATTACHMENTS_PER_MESSAGE} dosya olabilir` }, { status: 400 })
    try {
      const messageId = await insertMessage(threadId, actor.id, message, attachments)
      return NextResponse.json({ ok: true, messageId })
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Mesaj gönderilemedi' }, { status: 400 })
    }
  }

  if (action === 'close-thread') {
    if (!canCloseThread(actor, thread)) return NextResponse.json({ error: 'Bu sohbeti kapatma yetkiniz yok' }, { status: 403 })
    await pool.query(`UPDATE support_threads SET status='closed',"closedAt"=now(),"closedBy"=$2,"updatedAt"=now() WHERE id=$1`, [threadId, actor.id])
    await insertMessage(threadId, actor.id, `Sohbet ${actor.name} tarafından kapatıldı.`)
    return NextResponse.json({ ok: true, status: 'closed' })
  }

  return NextResponse.json({ error: 'Desteklenmeyen işlem' }, { status: 400 })
}
