import type { ItemAuthorData } from './types';

interface ProviderAnnotationOptions {
  source?: string;
  author?: ItemAuthorData;
  authored?: boolean;
}

export function formatProviderAnnotation({ source, author, authored }: ProviderAnnotationOptions): string | undefined {
  const parts = [source];
  if (author && authored !== true) {
    parts.push(formatAuthorAnnotation(author));
  }
  return parts.filter((value): value is string => Boolean(value)).join(' · ') || undefined;
}

function formatAuthorAnnotation(author: ItemAuthorData): string {
  return author.handle && !author.handle.includes('@') ? `@${author.handle}` : author.displayName;
}
