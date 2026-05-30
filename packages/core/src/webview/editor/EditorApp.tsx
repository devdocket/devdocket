import { useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import { getSerializedEditorState } from '../shared/editorState';
import { postMessage, setWebviewState } from '../shared/messaging';
import type { EditorItemData, ExtensionMessage } from '../shared/types';
import { useThemeChangeCounter } from '../shared/theme';
import { initialAutosaveState, reduceAutosaveState } from './autosaveState';
import { ActivityLog } from './components/ActivityLog';
import { ActionBar } from './components/ActionBar';
import { AutosaveIndicator } from './components/AutosaveIndicator';
import { CIWatchSection } from './components/CIWatchSection';
import { EditableField } from './components/EditableField';
import { EditorHeader } from './components/EditorHeader';
import { RelatedItems } from './components/RelatedItems';

declare global {
  interface Window {
    __DEVDOCKET_EDITOR_BOOTSTRAP__?: EditorItemData;
  }
}

export function EditorApp() {
  const bootstrapItem = window.__DEVDOCKET_EDITOR_BOOTSTRAP__ ?? null;
  const [item, setItem] = useState<EditorItemData | null>(bootstrapItem);
  const [title, setTitle] = useState(bootstrapItem?.title ?? '');
  const [notes, setNotes] = useState(bootstrapItem?.notes ?? '');
  const [url, setUrl] = useState(bootstrapItem?.url ?? '');
  const [autosaveState, dispatchAutosave] = useReducer(reduceAutosaveState, initialAutosaveState);
  // Re-render badges when the user switches VS Code theme.
  useThemeChangeCounter();

  const itemRef = useRef(item);
  const titleRef = useRef(title);
  const notesRef = useRef(notes);
  const urlRef = useRef(url);
  const autosaveTimerRef = useRef<number | undefined>(undefined);
  const autosaveRequestCounterRef = useRef(0);

  useEffect(() => {
    itemRef.current = item;
  }, [item]);

  useEffect(() => {
    const state = item ? getSerializedEditorState(item) : undefined;
    if (state) {
      setWebviewState(state);
    }
  }, [item?.id, item?.isIncoming, item?.providerId, item?.externalId]);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  useEffect(() => {
    urlRef.current = url;
  }, [url]);

  useEffect(() => {
    const handler = (event: MessageEvent<ExtensionMessage>) => {
      const message = event.data;
      switch (message.type) {
        case 'updateEditorItem':
          applyIncomingItem(message.item);
          break;
        case 'updateTitle':
          applyIncomingTitle(message.title);
          break;
        case 'autosaveAck':
          dispatchAutosave({ type: 'ack', requestId: message.requestId, savedAt: message.savedAt });
          break;
        case 'autosaveError':
          dispatchAutosave({ type: 'error', requestId: message.requestId, message: message.message });
          break;
        default:
          break;
      }
    };

    window.addEventListener('message', handler);
    return () => {
      window.removeEventListener('message', handler);
    };
  }, []);

  useEffect(() => {
    return () => {
      clearAutosaveTimer();
    };
  }, []);

  const description = useMemo(() => item?.description ?? '', [item?.description]);
  const autosaveError = renderAutosaveError();

  // This is the single click path for editor anchors. Capture-phase handling
  // plus stopPropagation prevents VS Code's webview anchor interception from
  // also firing for the same click.
  const handleEditorClick = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) {
      return;
    }

    const anchor = event.target.closest('a');
    const href = anchor?.getAttribute('href');
    if (!href) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    postMessage({ type: 'openUrl', url: href });
  };

  if (!item) {
    return <div class="editor-empty-state">Loading item…</div>;
  }

  return (
    <div class="editor-app" onClickCapture={handleEditorClick}>
      <EditorHeader
        item={item}
        title={title}
        url={url}
        onCopyText={text => postMessage({ type: 'copyToClipboard', text })}
        onTitleInput={!item.isProviderManaged && !item.isIncoming ? value => {
          setTitle(value);
          titleRef.current = value;
          scheduleAutosave();
        } : undefined}
        onUrlInput={!item.isProviderManaged && !item.isIncoming ? value => {
          setUrl(value);
          urlRef.current = value;
          scheduleAutosave();
        } : undefined}
        statusIndicator={!item.isIncoming ? (
          <AutosaveIndicator status={autosaveState.status} savedAt={autosaveState.savedAt} />
        ) : undefined}
        actionButtons={
          <ActionBar
            item={item}
            onTransition={targetState => postMessage({ type: 'transitionState', itemId: item.id, targetState })}
            onRunAction={() => postMessage({ type: 'runAction', itemId: item.id })}
            onRunActionById={actionId => postMessage({ type: 'runActionById', itemId: item.id, actionId })}
            onAccept={() => item.providerId && item.externalId && postMessage({ type: 'acceptItem', providerId: item.providerId, externalId: item.externalId })}
            onAcceptAndRunAction={actionId => item.providerId && item.externalId && postMessage({ type: 'acceptAndRunAction', providerId: item.providerId, externalId: item.externalId, actionId })}
            onDismiss={() => item.providerId && item.externalId && postMessage({ type: 'dismissItem', providerId: item.providerId, externalId: item.externalId })}
          />
        }
      />
      {autosaveError}
      {description || !item.isIncoming ? (
        <section class="editor-section" aria-labelledby={description ? 'editor-description-heading' : undefined}>
          {description ? (
            <>
              <div class="editor-section-heading" id="editor-description-heading">Description</div>
              <div
                class="editor-description markdown-body"
                dangerouslySetInnerHTML={{ __html: description }}
              />
            </>
          ) : null}
          {item.isIncoming ? null : (
            <div class="editor-notes-field">
              <EditableField
                label="Notes"
                value={notes}
                multiline
                placeholder="Add notes..."
                onInput={value => {
                  setNotes(value);
                  notesRef.current = value;
                  scheduleAutosave();
                }}
              />
            </div>
          )}
        </section>
      ) : null}
      <RelatedItems
        items={item.relatedItems}
        onOpenItem={relatedItem => postMessage({
          type: 'openItem',
          itemId: relatedItem.targetItemId,
          providerId: relatedItem.targetProviderId,
          externalId: relatedItem.targetExternalId,
        })}
      />
      <CIWatchSection ciWatch={item.ciWatch} onOpenWatches={() => postMessage({
        type: 'openWatches',
        focusItemId: item.id,
        ...(item.providerId ? { focusProviderId: item.providerId } : {}),
        ...(item.externalId ? { focusExternalId: item.externalId } : {}),
      })} />
      <ActivityLog entries={item.activityLog} />
    </div>
  );

  function scheduleAutosave() {
    dispatchAutosave({ type: 'edit' });
    clearAutosaveTimer();
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = undefined;
      sendAutosaveNow();
    }, 500);
  }

  function clearAutosaveTimer() {
    if (autosaveTimerRef.current !== undefined) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = undefined;
    }
  }

  function syncFocusedDraftValue() {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLTextAreaElement && activeElement.classList.contains('editor-textarea')) {
      notesRef.current = activeElement.value;
      return;
    }

    if (activeElement instanceof HTMLInputElement && activeElement.classList.contains('editor-title-input')) {
      titleRef.current = activeElement.value;
      return;
    }

    if (activeElement instanceof HTMLInputElement && activeElement.classList.contains('editor-url-input')) {
      urlRef.current = activeElement.value;
    }
  }

  function sendAutosaveNow() {
    clearAutosaveTimer();
    syncFocusedDraftValue();
    const currentItem = itemRef.current;
    if (!currentItem || currentItem.isIncoming) {
      return;
    }

    const data: { title?: string; notes?: string; url?: string } = {
      notes: notesRef.current.trim(),
    };

    if (!currentItem.isProviderManaged) {
      data.title = titleRef.current.trim();
      data.url = urlRef.current.trim();
    }

    const requestId = `autosave-${++autosaveRequestCounterRef.current}`;
    dispatchAutosave({ type: 'send', requestId });
    postMessage({ type: 'autosave', requestId, data });
  }

  function renderAutosaveError() {
    if (autosaveState.status !== 'error') {
      return null;
    }

    return (
      <div class="editor-autosave-error" role="alert">
        <span>Couldn’t save changes{autosaveState.message ? `: ${autosaveState.message}` : '.'}</span>
        <button type="button" class="editor-button editor-button--secondary editor-autosave-retry" onClick={sendAutosaveNow}>Retry</button>
      </div>
    );
  }

  function applyIncomingItem(nextItem: EditorItemData) {
    const previousItem = itemRef.current;
    const nextTitle = shouldPreserveEditableField(previousItem, titleRef.current, previousItem?.title) ? titleRef.current : nextItem.title;
    const nextUrl = shouldPreserveEditableField(previousItem, urlRef.current, previousItem?.url) ? urlRef.current : nextItem.url ?? '';
    const nextNotes = shouldPreserveNotes(previousItem, notesRef.current) ? notesRef.current : nextItem.notes ?? '';

    setItem(nextItem);
    setTitle(nextTitle);
    setUrl(nextUrl);
    setNotes(nextNotes);
    itemRef.current = nextItem;
    titleRef.current = nextTitle;
    urlRef.current = nextUrl;
    notesRef.current = nextNotes;
  }

  function applyIncomingTitle(nextTitle: string) {
    const previousItem = itemRef.current;
    if (!previousItem) {
      return;
    }

    const updatedItem = { ...previousItem, title: nextTitle };
    const resolvedTitle = shouldPreserveEditableField(previousItem, titleRef.current, previousItem.title)
      ? titleRef.current
      : nextTitle;

    setItem(updatedItem);
    setTitle(resolvedTitle);
    itemRef.current = updatedItem;
    titleRef.current = resolvedTitle;
  }
}

function shouldPreserveEditableField(item: EditorItemData | null, draftValue: string, persistedValue?: string): boolean {
  return Boolean(item && !item.isProviderManaged && draftValue !== (persistedValue ?? ''));
}

function shouldPreserveNotes(item: EditorItemData | null, draftValue: string): boolean {
  return Boolean(item && draftValue !== (item.notes ?? ''));
}
