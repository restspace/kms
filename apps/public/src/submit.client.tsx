import { hydrateRoot } from 'react-dom/client'
import { SubmitPage, type SubmitBootstrap } from '@kms/ui'

const bootstrap = document.getElementById('bootstrap')
const root = document.getElementById('root')

if (bootstrap?.textContent && root) {
  const data = JSON.parse(bootstrap.textContent) as SubmitBootstrap
  hydrateRoot(root, <SubmitPage data={data} />)
}
