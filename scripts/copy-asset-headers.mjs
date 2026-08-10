// The [assets] binding serves apps/public/dist, but Vite's publicDir lands in
// dist/static — so _headers has to be placed at the assets root separately.
import { copyFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const r = (p) => fileURLToPath(new URL(p, import.meta.url))
mkdirSync(r('../apps/public/dist'), { recursive: true })
copyFileSync(r('../apps/public/_headers'), r('../apps/public/dist/_headers'))
console.log('assets: wrote dist/_headers')
