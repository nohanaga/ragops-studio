import { PORTAL_DISMISSED_KEY } from './constants'

export function isPortalDismissed(): boolean {
  return localStorage.getItem(PORTAL_DISMISSED_KEY) === '1'
}
