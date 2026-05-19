const GUIDE_FOCUS_SELECTOR = [
  'input:not([type="hidden"]):not(:disabled)',
  'textarea:not(:disabled)',
  'select:not(:disabled)',
  'button:not(:disabled)',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function isGuideFocusableElement(element: Element | null): element is HTMLElement {
  if (typeof HTMLElement === 'undefined' || !(element instanceof HTMLElement)) return false
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false
  if (element instanceof HTMLInputElement && element.type === 'hidden') return false
  if ('disabled' in element && (element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled === true) return false
  const style = window.getComputedStyle(element)
  if (style.display === 'none' || style.visibility === 'hidden') return false
  return element.matches(GUIDE_FOCUS_SELECTOR)
}

export function focusGuideTargetElement(element: Element): boolean {
  const target = isGuideFocusableElement(element)
    ? element
    : Array.from(element.querySelectorAll<HTMLElement>(GUIDE_FOCUS_SELECTOR)).find(isGuideFocusableElement) ?? null

  if (!target) return false
  try {
    target.focus({ preventScroll: true })
  } catch {
    target.focus()
  }
  return document.activeElement === target
}