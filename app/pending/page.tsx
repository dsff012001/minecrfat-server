import { Clock3 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default function PendingPage() {
  return <main className="grid min-h-svh place-items-center bg-background p-4"><Card className="max-w-md text-center"><CardHeader><Clock3 className="mx-auto text-primary"/><CardTitle>Hesap onayı bekleniyor</CardTitle></CardHeader><CardContent className="text-sm leading-6 text-muted-foreground">Bir yönetici hesabınızı onayladıktan sonra sunucu paneline erişebilirsiniz.</CardContent></Card></main>
}
