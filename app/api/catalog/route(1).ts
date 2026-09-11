import { NextRequest, NextResponse } from 'next/server'

export const revalidate = 3600

type MojangManifest = { versions: Array<{ id: string; type: string }> }
export async function GET(request: NextRequest) {
  const loader = request.nextUrl.searchParams.get('loader') ?? 'vanilla'
  const mcVersion = request.nextUrl.searchParams.get('mcVersion')
  try {
    const manifest = await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', { next: { revalidate: 3600 } }).then(r => { if (!r.ok) throw new Error('Mojang kataloğu alınamadı'); return r.json() }) as MojangManifest
    const minecraft = manifest.versions.filter(v => v.type === 'release').slice(0, 80).map(v => v.id)
    if (!mcVersion || loader === 'vanilla' || loader === 'paper') return NextResponse.json({ minecraft, loaderVersions: [] })
    if (loader === 'fabric') {
      const rows = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`, { next: { revalidate: 3600 } }).then(r => r.ok ? r.json() : []) as Array<{ loader: { version: string; stable: boolean } }>
      return NextResponse.json({ minecraft, loaderVersions: rows.map(x => x.loader.version).slice(0, 30) })
    }
    const metadataUrl = loader === 'forge' ? 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml' : 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml'
    const xml = await fetch(metadataUrl, { next: { revalidate: 3600 } }).then(r => r.text())
    const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(x => x[1]).filter(Boolean).filter(v => { if(loader === 'forge') return v.startsWith(`${mcVersion}-`); return /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(v) }).reverse().slice(0, 80)
    return NextResponse.json({ minecraft, loaderVersions: versions })
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Katalog hatası' }, { status: 502 }) }
}
