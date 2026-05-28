import type { ComponentChildren } from 'preact';
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
  const inputId = useId();
  const accessoryId = useId();
  const hintId = useId();

  useEffect(() => {
    if (!multiline || !textareaRef.current) {
      return;
    }

    const element = textareaRef.current;
    element.style.height = '0px';
    element.style.height = `${Math.max(element.scrollHeight, 120)}px`;
  }, [multiline, value]);

  const describedBy = [
    labelAccessory !== undefined ? accessoryId : undefined,
    hint ? hintId : undefined,
  ].filter(Boolean).join(' ') || undefined;

  return (
    <div class="editor-field">
      <div class="editor-field-label-row">
        <label class="editor-field-label" for={inputId}>{label}</label>
        {labelAccessory !== undefined ? (
          <span id={accessoryId} class="editor-field-label-accessory" role="status" aria-live="polite">{labelAccessory}</span>
        ) : null}
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
