import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default async function AuthErrorPage({ searchParams }: { searchParams: Promise<{ message?: string }> }) {
  const { message } = await searchParams
  return <main className="grid min-h-svh place-items-center bg-background p-4"><Card className="w-full max-w-md text-center"><CardHeader><CardTitle>Doğrulama tamamlanamadı</CardTitle></CardHeader><CardContent className="flex flex-col gap-4"><p className="text-sm text-muted-foreground">{message ?? 'Bağlantı geçersiz veya süresi dolmuş.'}</p><Button><Link href="/sign-in">Giriş sayfasına dön</Link></Button></CardContent></Card></main>
}
