import { eq, or } from 'drizzle-orm'
import type { User } from '@supabase/supabase-js'
import { resolve, sep } from 'node:path'
import { db } from '@/lib/db'
import { user } from '@/lib/db/schema'

export type AuthUser = Pick<User, 'id' | 'email'> & { user_metadata?: Record<string, unknown> }

export async function resolvePanelUser(authUser: AuthUser) {
  const email = authUser.email?.trim().toLowerCase()
  const matches = await db.select().from(user).where(email ? or(eq(user.id, authUser.id), eq(user.email, email)) : eq(user.id, authUser.id)).limit(2)
  const existing = matches[0]
  if (!existing) return null
  if (existing.id === authUser.id && existing.email === email) return existing
  if (email && existing.email === email) return existing
  return existing
}

export async function resolvePanelUserBySession(sessionUser: AuthUser) {
  return resolvePanelUser(sessionUser)
}

export function isApprovedPanelUser(actor: { approved: boolean }) {
  return actor.approved === true
}

export function safeRelativePath(root: string, requested: string) {
  if (requested.includes('\0')) throw new Error('Invalid path')
  const normalized = requested.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) throw new Error('Absolute paths are not allowed')
  const target = resolve(root, normalized)
  const base = resolve(root)
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error('Path traversal blocked')
  return target
}
