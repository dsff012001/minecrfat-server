'use client'

import { FormEvent, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Box, LoaderCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

export default function ForgotPasswordPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [pending, setPending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError('')
    const { error: resetError } = await createClient().auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    })
    setPending(false)
    if (resetError) {
      setError('İstek şu anda tamamlanamadı. Lütfen e-posta adresinizi kontrol edip tekrar deneyin.')
      return
    }
    setSent(true)
  }

  return <main className="grid min-h-svh place-items-center bg-background p-4 font-sans">
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <span className="mx-auto grid size-12 place-items-center rounded-md bg-primary text-primary-foreground"><Box /></span>
        <CardTitle className="text-2xl">Şifreni sıfırla</CardTitle>
        <CardDescription>{sent ? 'E-posta kutunu kontrol et ve bağlantıyı kullan.' : 'Hesabına bağlı e-posta adresini gir.'}</CardDescription>
      </CardHeader>
      <CardContent>
        {sent ? <div className="flex flex-col gap-4 text-center">
          <p className="text-sm text-muted-foreground">Şifre yenileme bağlantısı e-posta adresine gönderildi. Gelmediyse spam klasörünü de kontrol et.</p>
          <Button type="button" onClick={() => router.push('/sign-in')}>Giriş sayfasına dön</Button>
        </div> : <form onSubmit={submit} className="flex flex-col gap-5">
          <FieldGroup><Field><FieldLabel htmlFor="email">E-posta</FieldLabel><Input id="email" name="email" type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></Field></FieldGroup>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button disabled={pending} type="submit" className="w-full">{pending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}Sıfırlama bağlantısı gönder</Button>
          <Button type="button" variant="ghost" onClick={() => router.push('/sign-in')}><ArrowLeft data-icon="inline-start" />Giriş sayfasına dön</Button>
        </form>}
      </CardContent>
    </Card>
  </main>
}
