interface SearchBoxProps {
  label: string;
  query: string;
  onChange: (query: string) => void;
  onClear: () => void;
}

export function SearchBox({ label, query, onChange, onClear }: SearchBoxProps) {
  const clearLabel = `Clear ${label}`;

  return (
    <div class="search-box">
      <div class="search-box-input-wrap">
        <input
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
            if (query.length > 0) {
              onClear();
            } else {
              (event.currentTarget as HTMLInputElement).blur();
            }
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
