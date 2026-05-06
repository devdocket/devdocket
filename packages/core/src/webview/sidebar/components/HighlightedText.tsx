import { Fragment } from 'preact';
import { splitOnMatches } from '../filter';

interface HighlightedTextProps {
  text: string;
  query?: string;
}

export function HighlightedText({ text, query = '' }: HighlightedTextProps) {
  const segments = splitOnMatches(text, query);

  if (!query.trim()) {
    return <>{text}</>;
  }

  return (
    <>
      {segments.map((segment, index) => segment.isMatch ? (
        <mark key={index}>{segment.text}</mark>
      ) : (
        <Fragment key={index}>{segment.text}</Fragment>
      ))}
    </>
  );
}
