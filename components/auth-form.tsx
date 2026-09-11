'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Box, LoaderCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

export function AuthForm({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  async function submit(formData: FormData) {
    setPending(true)
    setError('')
    try {
      const email = String(formData.get('email') ?? '').trim().toLowerCase()
      const password = String(formData.get('password') ?? '')
      const name = String(formData.get('name') ?? '').trim()
      if (!email || !email.includes('@')) throw new Error('Geçerli bir e-posta adresi girin.')
      if (password.length < 8) throw new Error('Şifre en az 8 karakter olmalıdır.')
      if (mode === 'sign-up' && name.length < 2) throw new Error('Ad soyad en az 2 karakter olmalıdır.')
      const supabase = createClient()
      if (mode === 'sign-up') {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: process.env.NEXT_PUBLIC_DEV_SUPABASE_REDIRECT_URL ?? `${window.location.origin}/auth/callback?next=/auth/confirmed`,
            data: { name },
          },
        })
        if (signUpError) throw new Error(signUpError.message.includes('rate') ? 'Çok fazla deneme yapıldı. Lütfen biraz bekleyin.' : signUpError.message.includes('weak') ? 'Şifre daha güçlü olmalıdır.' : 'Kayıt tamamlanamadı. Bilgilerinizi kontrol edin.')
        if (!data.session) {
          setError('Kayıt başarılı. Devam etmek için e-posta adresinize gönderilen doğrulama bağlantısına tıklayın.')
          return
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
        if (signInError) throw new Error(signInError.message.includes('confirm') ? 'Önce e-posta adresinizi doğrulamanız gerekiyor.' : 'E-posta veya şifre hatalı.')
      }
      router.replace('/')
      router.refresh()
    } catch (cause) {
      console.error('[v0] Authentication request error:', cause)
      const message = cause instanceof Error ? cause.message : 'İşlem tamamlanamadı.'
      setError(message)
    } finally {
      setPending(false)
    }
  }

  return <main className="grid min-h-svh place-items-center bg-background p-4 font-sans">
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <span className="mx-auto grid size-12 place-items-center rounded-md bg-primary text-primary-foreground"><Box /></span>
        <CardTitle className="text-2xl">{mode === 'sign-in' ? 'BlockCtrl oturumu' : 'Yönetici hesabı oluştur'}</CardTitle>
        <CardDescription>{mode === 'sign-in' ? 'Minecraft altyapınızı yönetmek için giriş yapın.' : 'İlk hesap yönetici olur; sonraki hesaplar onay bekler.'}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={submit} className="flex flex-col gap-5">
          <FieldGroup>
            {mode === 'sign-up' && <Field><FieldLabel htmlFor="name">Ad soyad</FieldLabel><Input id="name" name="name" required minLength={2} autoComplete="name" /></Field>}
            <Field><FieldLabel htmlFor="email">E-posta</FieldLabel><Input id="email" name="email" type="email" required autoComplete="email" /></Field>
            <Field><FieldLabel htmlFor="password">Şifre</FieldLabel><Input id="password" name="password" type="password" required minLength={8} autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'} /></Field>
          </FieldGroup>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button disabled={pending} type="submit" className="w-full">{pending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}{mode === 'sign-in' ? 'Giriş yap' : 'Hesap oluştur'}</Button>
          {mode === 'sign-in' && <Button type="button" variant="link" className="h-auto p-0" onClick={() => router.push('/forgot-password')}>Şifremi unuttum</Button>}
          <Button type="button" variant="ghost" onClick={() => router.push(mode === 'sign-in' ? '/sign-up' : '/sign-in')}>{mode === 'sign-in' ? 'Yeni hesap oluştur' : 'Zaten hesabım var'}</Button>
        </form>
      </CardContent>
    </Card>
  </main>
}
