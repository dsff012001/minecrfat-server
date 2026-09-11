import { headers } from 'next/headers'
import { NextRequest } from 'next/server'
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { auth } from '@/lib/auth'
import { ensurePanelSchema, pool } from '@/lib/db'
import { resolvePanelUser } from '@/lib/db/identity'

export const runtime = 'nodejs'

const SUPPORT_RULES_VERSION = '2026-09-10-v1'
const STAFF_ROLES = new Set(['manager', 'admin', 'guide'])
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
const ALLOWED_CONTENT_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v',
]

function roleOf(value: unknown) { const role = String(value ?? '').toLowerCase(); return ['manager','admin','guide','member'].includes(role) ? role : 'member' }
function isStaff(value: unknown) { return STAFF_ROLES.has(roleOf(value)) }
async function actor() { const session = await auth.api.getSession({ headers: await headers() }); if (!session?.user) return null; return resolvePanelUser(session.user) }

async function canAccessThread(userId:string, role:string, threadId:string) {
  const result = await pool.query<{type:string;status:string;creatorUserId:string;targetUserId:string|null;assignedUserId:string|null}>(`SELECT type,status,"creatorUserId","targetUserId","assignedUserId" FROM support_threads WHERE id=$1 LIMIT 1`, [threadId])
  const thread = result.rows[0]
  if (!thread || thread.status === 'closed' || thread.status === 'declined') return false
  if (thread.type === 'private') return thread.status === 'open' && (thread.creatorUserId === userId || thread.targetUserId === userId)
  if (thread.creatorUserId === userId) return thread.status === 'pending' || thread.status === 'open'
  return isStaff(role) && thread.status === 'open' && thread.assignedUserId === userId
}

export async function POST(request: NextRequest) {
  await ensurePanelSchema()
  const current = await actor()
  if (!current) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  if (!current.approved) return Response.json({ error: 'Approval required' }, { status: 403 })
  if (!isStaff(current.role)) {
    const consent = await pool.query<{version:string}>(`SELECT version FROM support_consents WHERE "userId"=$1 LIMIT 1`, [current.id])
    if (consent.rows[0]?.version !== SUPPORT_RULES_VERSION) return Response.json({ error: 'Önce destek bilgilendirmesini kabul edin' }, { status: 428 })
  }
  const body = await request.json() as HandleUploadBody
  try {
    const response = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        let payload: { threadId?: string } = {}
        try { payload = clientPayload ? JSON.parse(clientPayload) : {} } catch { throw new Error('Geçersiz yükleme isteği') }
        const threadId = String(payload.threadId ?? '')
        if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw new Error('Geçersiz sohbet kimliği')
        if (!pathname.startsWith(`support/${threadId}/`)) throw new Error('Geçersiz dosya yolu')
        if (!await canAccessThread(current.id, roleOf(current.role), threadId)) throw new Error('Bu sohbete dosya yükleme yetkiniz yok')
        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: MAX_ATTACHMENT_BYTES,
          tokenPayload: JSON.stringify({ userId: current.id, threadId }),
        }
      },
      onUploadCompleted: async () => {
        // Mesaj API'si dosyayı ilgili mesaja bağlar. Burada hassas veri loglanmaz.
      },
    })
    return Response.json(response)
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Dosya yüklenemedi' }, { status: 400 })
  }
}
