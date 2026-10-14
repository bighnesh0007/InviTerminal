import type { RendererApi } from '../shared/ipc';
import { LANGUAGES, textForInsert, type Language, type LibraryStatus, type Snippet, type SnippetInput } from '../shared/snippet';
import { button, el } from './dom';

export interface LibraryView {
  element: HTMLElement;
  toggle(): void;
  isOpen(): boolean;
  focusSearch(): void;
}

const PREVIEW_LINES = 12;

/**
 * Searchable snippet library. "Insert" pastes into the terminal through
 * xterm's paste() (bracketed when the shell asked for it) and never adds a
 * newline, so a snippet is never run by inserting it; multi-line snippets
 * need a confirmation first.
 */
export function mountLibrary(api: RendererApi, opts: { paste(text: string): void; onOpenChange(open: boolean): void; inputAllowed(): boolean }): LibraryView {
  const status = el('p', { className: 'lib-status' });
  const message = el('p', { className: 'lib-message' });
  const search = el('input', { className: 'lib-search' });
  search.type = 'search';
  search.placeholder = 'Search snippets…';
  search.spellcheck = false;
  const folderSelect = el('select', { className: 'lib-folder' });
  const trashToggle = el('input');
  trashToggle.type = 'checkbox';
  const list = el('ul', { className: 'lib-list' });
  const editor = el('form', { className: 'lib-editor' });
  editor.hidden = true;
  const confirmBox = el('div', { className: 'lib-confirm' });
  confirmBox.hidden = true;

  const panel = el('aside', { className: 'library' });
  panel.hidden = true;

  const say = (text: string) => {
    message.textContent = text;
  };

  let libStatus: LibraryStatus | null = null;
  let searchSeq = 0;

  function renderStatus(s: LibraryStatus): void {
    libStatus = s;
    status.replaceChildren();
    status.dataset.state = s.state;
    if (s.state === 'ready') status.append(`MongoDB ${s.target}`);
    else if (s.state === 'connecting') status.append(`Connecting to MongoDB ${s.target}…`);
    else status.append(`Library unavailable — ${s.reason} `, button('Retry', async () => renderStatus(await api.library.retry()), say));
    if (s.state === 'ready') void refresh();
  }

  async function refreshFolders(): Promise<void> {
    const current = folderSelect.value;
    const folders = await api.library.folders();
    folderSelect.replaceChildren(Object.assign(el('option', { text: 'All folders' }), { value: '' }), ...folders.map((f) => Object.assign(el('option', { text: f }), { value: f })));
    folderSelect.value = folders.includes(current) ? current : '';
  }

  async function refresh(): Promise<void> {
    if (libStatus?.state !== 'ready') return;
    const seq = ++searchSeq;
    const q: Parameters<RendererApi['library']['search']>[0] = { deleted: trashToggle.checked };
    if (search.value.trim()) q.q = search.value.trim();
    if (folderSelect.value) q.folder = folderSelect.value;
    const [items] = await Promise.all([api.library.search(q), refreshFolders()]);
    if (seq !== searchSeq) return; // a newer search superseded this one
    list.replaceChildren(...items.map(renderItem));
    if (items.length === 0) list.append(el('li', { className: 'lib-empty', text: trashToggle.checked ? 'Trash is empty.' : search.value ? 'No matches.' : 'No snippets yet — click New.' }));
  }

  function renderItem(s: Snippet): HTMLLIElement {
    const meta = [s.folder, ...s.tags.map((t) => `#${t}`)].filter(Boolean).join('  ');
    const preview = s.body.split('\n')[0] ?? '';
    const actions = el('div', { className: 'lib-actions' });
    if (s.deletedAt) {
      actions.append(button('Restore', async () => {
        await api.library.restore(s.id);
        say(`Restored “${s.title}”.`);
        await refresh();
      }, say));
    } else {
      actions.append(
        button('Insert', () => insert(s), say),
        button('Copy', async () => {
          await api.clipboard.write(s.body);
          await api.library.used(s.id);
          say(`Copied “${s.title}”. Clipboard managers and history can keep it.`);
        }, say),
        button('Edit', () => openEditor(s), say),
        button('Delete', async () => {
          await api.library.trash(s.id);
          message.replaceChildren(`Moved “${s.title}” to trash. `, button('Undo', async () => {
            await api.library.restore(s.id);
            say(`Restored “${s.title}”.`);
            await refresh();
          }, say));
          await refresh();
        }, say),
      );
    }
    const li = el('li', { className: 'lib-item' }, el('div', { className: 'lib-title', text: s.title }), el('div', { className: 'lib-meta', text: meta }), el('code', { className: 'lib-preview', text: preview }), actions);
    li.dataset.snippetId = s.id;
    return li;
  }

  function insert(s: Snippet): void {
    if (!opts.inputAllowed()) {
      say('The terminal is covered until protection is confirmed; nothing was inserted.');
      return;
    }
    const { text, multiline } = textForInsert(s.body);
    const doInsert = async () => {
      opts.paste(text);
      await api.library.used(s.id);
      say(`Inserted “${s.title}” — review it, then press Enter to run.`);
    };
    if (!multiline) {
      void doInsert();
      return;
    }
    const lines = text.split('\n');
    const shown = lines.slice(0, PREVIEW_LINES).join('\n') + (lines.length > PREVIEW_LINES ? `\n… ${lines.length - PREVIEW_LINES} more lines` : '');
    confirmBox.replaceChildren(
      el('p', { text: `Insert ${lines.length} lines into the terminal? Nothing runs until you press Enter, but check it first:` }),
      el('pre', { text: shown }),
      el(
        'div',
        { className: 'lib-actions' },
        button('Insert', async () => {
          confirmBox.hidden = true;
          await doInsert();
        }, say),
        button('Cancel', () => {
          confirmBox.hidden = true;
          say('Insert cancelled.');
        }),
      ),
    );
    confirmBox.hidden = false;
  }

  // ---- editor ---------------------------------------------------------------------
  const fTitle = el('input');
  const fFolder = el('input');
  const fTags = el('input');
  const fLang = el('select');
  for (const l of LANGUAGES) fLang.append(Object.assign(el('option', { text: l }), { value: l }));
  const fDesc = el('input');
  const fBody = el('textarea');
  fBody.spellcheck = false;
  fBody.rows = 10;
  let editing: Snippet | null = null;

  const field = (label: string, input: HTMLElement) => el('label', { className: 'lib-field' }, el('span', { text: label }), input);
  editor.append(
    field('Title', fTitle),
    field('Folder (a/b)', fFolder),
    field('Tags (comma-separated)', fTags),
    field('Language', fLang),
    field('Description', fDesc),
    field('Body', fBody),
    el(
      'div',
      { className: 'lib-actions' },
      button('Save', async () => {
        const input: SnippetInput = {
          title: fTitle.value,
          body: fBody.value,
          description: fDesc.value,
          language: fLang.value as Language,
          tags: fTags.value.split(',').map((t) => t.trim()).filter(Boolean),
          folder: fFolder.value,
        };
        const saved = editing ? await api.library.update(editing.id, input) : await api.library.create(input);
        say(`Saved “${saved.title}”.`);
        closeEditor();
        await refresh();
      }, say),
      button('Cancel', () => closeEditor()),
    ),
  );
  editor.addEventListener('submit', (e) => e.preventDefault());

  function openEditor(s: Snippet | null): void {
    editing = s;
    fTitle.value = s?.title ?? '';
    fFolder.value = s?.folder ?? folderSelect.value;
    fTags.value = s?.tags.join(', ') ?? '';
    fLang.value = s?.language ?? 'bash';
    fDesc.value = s?.description ?? '';
    fBody.value = s?.body ?? '';
    editor.hidden = false;
    list.hidden = true;
    fTitle.focus();
  }

  function closeEditor(): void {
    editor.hidden = true;
    list.hidden = false;
    editing = null;
  }

  // ---- layout & events ------------------------------------------------------------------
  let debounce = 0;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = window.setTimeout(() => void refresh().catch((e: Error) => say(e.message)), 150);
  });
  folderSelect.addEventListener('change', () => void refresh().catch((e: Error) => say(e.message)));
  trashToggle.addEventListener('change', () => void refresh().catch((e: Error) => say(e.message)));

  panel.append(
    el('div', { className: 'lib-head' }, el('strong', { text: 'Snippets' }), button('New', () => openEditor(null), say)),
    status,
    el('div', { className: 'lib-filters' }, search, folderSelect, el('label', { className: 'lib-trash' }, trashToggle, el('span', { text: 'Trash' }))),
    message,
    confirmBox,
    editor,
    list,
  );

  api.library.onStatus(renderStatus);
  void api.library.status().then(renderStatus);

  return {
    element: panel,
    toggle() {
      panel.hidden = !panel.hidden;
      opts.onOpenChange(!panel.hidden);
      if (!panel.hidden) {
        search.focus();
        void refresh().catch((e: Error) => say(e.message));
      }
    },
    isOpen: () => !panel.hidden,
    focusSearch: () => search.focus(),
  };
}
