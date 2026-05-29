import { useEffect, useId, useRef } from 'preact/hooks';

interface EditableFieldProps {
  label: string;
  value: string;
  onInput?: (value: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  multiline?: boolean;
  type?: 'text' | 'url';
  hint?: string;
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
}: EditableFieldProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const inputId = useId();
  const hintId = useId();

  useEffect(() => {
    if (!multiline || !textareaRef.current) {
      return;
    }

    const element = textareaRef.current;
    element.style.height = '0px';
    element.style.height = `${Math.max(element.scrollHeight, 120)}px`;
  }, [multiline, value]);

  const describedBy = hint ? hintId : undefined;

  return (
    <div class="editor-field">
      <div class="editor-field-label-row">
        <label class="editor-field-label" for={inputId}>{label}</label>
      </div>
      {multiline ? (
        <textarea
          id={inputId}
          ref={textareaRef}
          class="editor-input editor-textarea"
          value={value}
          placeholder={placeholder}
          readOnly={readOnly}
          aria-describedby={describedBy}
          onInput={event => onInput?.(event.currentTarget.value)}
        />
      ) : (
        <input
          id={inputId}
          class="editor-input"
          type={type}
          value={value}
          placeholder={placeholder}
          readOnly={readOnly}
          aria-describedby={describedBy}
          onInput={event => onInput?.(event.currentTarget.value)}
        />
      )}
      {hint ? <span id={hintId} class="editor-field-hint">{hint}</span> : null}
    </div>
  );
}
