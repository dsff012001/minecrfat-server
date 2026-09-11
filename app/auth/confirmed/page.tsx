import Link from 'next/link'
import { CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default function ConfirmedPage() {
  return <main className="grid min-h-svh place-items-center bg-background p-4"><Card className="w-full max-w-md text-center"><CardHeader><CheckCircle2 className="mx-auto text-primary" size={40}/><CardTitle>E-posta doğrulandı</CardTitle></CardHeader><CardContent className="flex flex-col gap-4"><p className="text-sm leading-6 text-muted-foreground">Hesabınız doğrulandı. Panele devam etmek için giriş yapabilirsiniz.</p><Button><Link href="/sign-in">Giriş yap</Link></Button></CardContent></Card></main>
}
