import { count, eq } from 'drizzle-orm'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { ControlPanel } from '@/components/control-panel'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { user } from '@/lib/db/schema'

export default async function Page() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/sign-in')
  let [record] = await db.select().from(user).where(eq(user.id, session.user.id)).limit(1)
  const [{ value }] = await db.select({ value: count() }).from(user)
  if (record && value === 1 && (!record.approved || record.role !== 'admin')) {
    ;[record] = await db.update(user).set({ role: 'admin', approved: true, updatedAt: new Date() }).where(eq(user.id, record.id)).returning()
  }
  if (!record?.approved) redirect('/pending')
  return <ControlPanel />
}
