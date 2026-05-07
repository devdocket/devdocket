import { useEffect, useRef } from 'preact/hooks';

interface SearchBoxProps {
  label: string;
  query: string;
  onChange: (query: string) => void;
  onClear: () => void;
  autoFocus?: boolean;
}

export function SearchBox({ label, query, onChange, onClear, autoFocus = false }: SearchBoxProps) {
  const clearLabel = `Clear ${label}`;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
    }
  }, [autoFocus]);

  return (
    <div class="search-box">
      <div class="search-box-input-wrap">
        <input
          ref={inputRef}
          type="search"
          value={query}
          aria-label={label}
          placeholder="Search"
          onInput={(event) => onChange((event.currentTarget as HTMLInputElement).value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') {
              return;
            }

            event.preventDefault();
            onClear();
          }}
        />
        {query.length > 0 ? (
          <button
            type="button"
            class="search-box-clear"
            aria-label={clearLabel}
            title={clearLabel}
            onClick={onClear}
          >
            ×
          </button>
        ) : null}
      </div>
    </div>
  );
}
