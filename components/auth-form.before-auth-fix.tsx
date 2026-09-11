'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Box, LoaderCircle } from 'lucide-react'
import { authClient } from '@/lib/auth-client'
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
    const email = String(formData.get('email') ?? '')
    const password = String(formData.get('password') ?? '')
    const result = mode === 'sign-up'
      ? await authClient.signUp.email({ email, password, name: String(formData.get('name') ?? '') })
      : await authClient.signIn.email({ email, password })
    setPending(false)
    if (result.error) return setError(result.error.message ?? 'İşlem tamamlanamadı.')
    router.push('/')
    router.refresh()
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
          <Button disabled={pending} type="submit">{pending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}{mode === 'sign-in' ? 'Giriş yap' : 'Hesap oluştur'}</Button>
          <Button type="button" variant="ghost" onClick={() => router.push(mode === 'sign-in' ? '/sign-up' : '/sign-in')}>{mode === 'sign-in' ? 'Yeni hesap oluştur' : 'Zaten hesabım var'}</Button>
        </form>
      </CardContent>
    </Card>
  </main>
}
