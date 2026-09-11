import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { backups, nodes, serverPermissions, servers, worlds } from '@/lib/db/schema'

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const row = (await db.select({ backup: backups, world: worlds, server: servers, node: nodes }).from(backups).innerJoin(worlds, eq(backups.worldId, worlds.id)).innerJoin(servers, eq(worlds.serverId, servers.id)).innerJoin(nodes, eq(servers.nodeId, nodes.id)).where(and(eq(backups.id, id), eq(servers.userId, session.user.id))).limit(1))[0]
  if (!row) return NextResponse.json({ error: 'Yedek bulunamadı' }, { status: 404 })
  const permission = (await db.select({ canBackup: serverPermissions.canBackup }).from(serverPermissions).where(and(eq(serverPermissions.serverId, row.server.id), eq(serverPermissions.userId, session.user.id))).limit(1))[0]
  if (row.server.userId !== session.user.id && !permission?.canBackup) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const base = process.env.NODE_DOWNLOAD_URL || process.env.NODE_AGENT_BASE_URL || ''
  if (!base) return NextResponse.json({ error: 'Node download URL is not configured' }, { status: 503 })
  let upstream: Response
  try {
    upstream = await fetch(`${base.replace(/\/$/, '')}/internal/backups/${id}/download`, { headers: { Authorization: `Bearer ${process.env.NODE_TOKEN}`, 'x-backup-path': row.backup.blobPathname }, signal: AbortSignal.timeout(30000) })
  } catch {
    return NextResponse.json({ error: 'Node download adresine erişilemedi. NODE_DOWNLOAD_URL ve Oracle ağ ayarlarını kontrol edin.' }, { status: 502 })
  }
  if (upstream.status === 404) return NextResponse.json({ error: 'Arşiv dosyası bulunamadı' }, { status: 404 })
  if (!upstream.ok || !upstream.body) return NextResponse.json({ error: 'Node indirme köprüsüne erişilemedi' }, { status: 502 })
  return new NextResponse(upstream.body, { status: 200, headers: { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${row.backup.blobPathname.split('/').pop() || 'backup.tar.gz'}"`, ...(upstream.headers.get('content-length') ? { 'Content-Length': upstream.headers.get('content-length')! } : {}) } })
}
