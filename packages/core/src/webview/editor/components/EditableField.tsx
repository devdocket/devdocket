import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

interface EditableFieldProps {
  label: string;
  value: string;
  onInput?: (value: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  multiline?: boolean;
  type?: 'text' | 'url';
  hint?: string;
  labelAccessory?: ComponentChildren;
}

export function EditableField({
  label,
  value,
  onInput,
  placeholder,
  readOnly,
  multiline,
  type = 'text',
  hint,
  labelAccessory,
}: EditableFieldProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!multiline || !textareaRef.current) {
      return;
    }

    const element = textareaRef.current;
    element.style.height = '0px';
    element.style.height = `${Math.max(element.scrollHeight, 120)}px`;
  }, [multiline, value]);

  return (
    <label class="editor-field">
      <span class="editor-field-label-row">
        <span class="editor-field-label">{label}</span>
        {labelAccessory !== undefined ? (
          <span class="editor-field-label-accessory" role="status" aria-live="polite">{labelAccessory}</span>
        ) : null}
      </span>
      {multiline ? (
        <textarea
          ref={textareaRef}
          class="editor-input editor-textarea"
          value={value}
          placeholder={placeholder}
          readOnly={readOnly}
          onInput={event => onInput?.((event.target as HTMLTextAreaElement).value)}
        />
      ) : (
        <input
          class="editor-input"
          type={type}
          value={value}
          placeholder={placeholder}
          readOnly={readOnly}
          onInput={event => onInput?.((event.target as HTMLInputElement).value)}
        />
      )}
      {hint ? <span class="editor-field-hint">{hint}</span> : null}
    </label>
  );
}
