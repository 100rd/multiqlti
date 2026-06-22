/**
 * Copy text to the clipboard, with a fallback for NON-SECURE origins.
 *
 * `navigator.clipboard` is only available in a secure context (https or
 * localhost). When the app is opened over a plain-http LAN IP
 * (e.g. http://192.168.100.195:5050), that API is missing / rejects — so fall
 * back to the legacy `document.execCommand("copy")` textarea trick, which still
 * works on http origins.
 *
 * Returns true on success, false if both paths fail (caller decides how to
 * surface that — e.g. a destructive toast).
 */
export async function copyText(text: string): Promise<boolean> {
  // Preferred path — async Clipboard API, only trustworthy in a secure context.
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }

  // Legacy fallback — works over http (non-secure) origins.
  try {
    const active = document.activeElement as HTMLElement | null;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    // Keep it off-screen and non-disruptive to layout / scroll position.
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    // Restore focus to whatever the user was on.
    active?.focus?.();
    return ok;
  } catch {
    return false;
  }
}
