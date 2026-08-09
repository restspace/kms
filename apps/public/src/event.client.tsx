import { hydrateRoot } from 'react-dom/client'
import { EventPage, type EventPageBootstrap } from '@kms/ui'

const bootstrap = document.getElementById('bootstrap')
const root = document.getElementById('root')

if (bootstrap?.textContent && root) {
  const data = JSON.parse(bootstrap.textContent) as EventPageBootstrap
  hydrateRoot(root, <EventPage data={data} />)
}
