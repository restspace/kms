import { hydrateRoot } from 'react-dom/client'
import { HelloPage, type HelloPageData } from '@kms/ui'

const bootstrap = document.getElementById('bootstrap')
const root = document.getElementById('root')

if (bootstrap?.textContent && root) {
  const data = JSON.parse(bootstrap.textContent) as HelloPageData
  hydrateRoot(root, <HelloPage data={data} />)
}
