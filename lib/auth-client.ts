'use client'

import { createClient } from '@/lib/supabase/client'

export const authClient = {
  signOut: () => createClient().auth.signOut(),
  signIn: { email: async (_input?: unknown) => ({ error: new Error('Use Supabase Auth') }) },
  signUp: { email: async (_input?: unknown) => ({ error: new Error('Use Supabase Auth') }) },
}
export const { signOut } = authClient
