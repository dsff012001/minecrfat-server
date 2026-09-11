'use client'

import { FormEvent, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Box, LoaderCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

export default function ResetPasswordPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    if (password.length < 8) { setError('Şifre en az 8 karakter olmalıdır.'); return }
    if (password !== confirmPassword) { setError('Şifreler eşleşmiyor.'); return }
    setPending(true)
    const { error: updateError } = await createClient().auth.updateUser({ password })
    setPending(false)
    if (updateError) { setError('Şifre güncellenemedi. Yeni bir sıfırlama bağlantısı isteyin.'); return }
    router.replace('/sign-in?reset=success')
  }

  return <main className="grid min-h-svh place-items-center bg-background p-4 font-sans">
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <span className="mx-auto grid size-12 place-items-center rounded-md bg-primary text-primary-foreground"><Box /></span>
        <CardTitle className="text-2xl">Yeni şifre belirle</CardTitle>
        <CardDescription>Hesabın için güçlü bir şifre oluştur.</CardDescription>
      </CardHeader>
      <CardContent><form onSubmit={submit} className="flex flex-col gap-5">
        <FieldGroup>
          <Field><FieldLabel htmlFor="password">Yeni şifre</FieldLabel><Input id="password" type="password" required minLength={8} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
          <Field><FieldLabel htmlFor="confirm-password">Yeni şifre tekrar</FieldLabel><Input id="confirm-password" type="password" required minLength={8} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></Field>
        </FieldGroup>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button disabled={pending} type="submit" className="w-full">{pending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}Şifreyi güncelle</Button>
        <Button type="button" variant="ghost" onClick={() => router.push('/sign-in')}><ArrowLeft data-icon="inline-start" />Giriş sayfasına dön</Button>
      </form></CardContent>
    </Card>
  </main>
}
