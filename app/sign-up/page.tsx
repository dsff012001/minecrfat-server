import { redirect } from 'next/navigation'
import { AuthForm } from '@/components/auth-form'
import { createClient } from '@/lib/supabase/server'

export default async function SignUpPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user) redirect('/')
  return <AuthForm mode="sign-up" />
}
