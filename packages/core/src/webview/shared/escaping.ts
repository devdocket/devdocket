const htmlEscapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => htmlEscapes[ch]);
}

export function escapeAttr(text: string): string {
  return text.replace(/[&<>"']/g, ch => htmlEscapes[ch]);
}
