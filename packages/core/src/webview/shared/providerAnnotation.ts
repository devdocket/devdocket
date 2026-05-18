import type { ItemAuthorData } from './types';

interface ProviderAnnotationOptions {
  source?: string;
  author?: ItemAuthorData;
  authored?: boolean;
}

export function formatProviderAnnotation({ source, author, authored }: ProviderAnnotationOptions): string | undefined {
  const parts = [source];
  if (author && authored !== true) {
    parts.push(author.handle ? `@${author.handle}` : author.displayName);
  }
  return parts.filter((value): value is string => Boolean(value)).join(' · ') || undefined;
}
