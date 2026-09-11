import { createClient } from '@/lib/supabase/server'

export const auth = {
  api: {
    async getSession(_options?: unknown) {
      const supabase = await createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return null
      return { user: { id: user.id, email: user.email ?? '', name: user.user_metadata?.name ?? user.email ?? '' } }
    },
  },
}
