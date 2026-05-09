const fallbackCopy = (text: string): boolean => {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    ta.style.pointerEvents = 'none'
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    prev?.focus()
    return ok
  } catch {
    return false
  }
}

export async function readClipboardText(): Promise<string> {
  if (window.electronAPI?.clipboard?.readText) {
    return window.electronAPI.clipboard.readText()
  }
  if (navigator.clipboard?.readText) {
    return navigator.clipboard.readText()
  }
  throw new Error('clipboard unavailable')
}

export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    if (window.electronAPI?.clipboard?.writeText) {
      await window.electronAPI.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to browser / legacy paths.
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to execCommand copy.
  }

  return fallbackCopy(text)
}
