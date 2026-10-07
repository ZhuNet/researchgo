import { Match, Show, Switch } from 'solid-js';

import { Icon } from '../Icon';
import { copyText, openMenu, railView, setTreeCmd, toast } from '../../store/ui';
import type { Workspace } from '../../store/workspace';
import { ChangesPanel } from './ChangesPanel';
import { FileTree } from './FileTree';
import { SearchPanel } from './SearchPanel';

const TITLES = {
  files: 'Explorer',
  search: 'Search',
  changes: 'Changes',
} as const;

export function Explorer(props: { ws: Workspace }) {
  const view = () => railView();

  return (
    <aside class="explorer">
      <div class="explorer__head">
        <h2 class="explorer__title">{TITLES[view()]}</h2>
        <div class="explorer__actions">
          <Switch>
            <Match when={view() === 'files'}>
              <button
                class="icon-btn"
                title="New file  ⌘N"
                onClick={() => {
                  const dir = props.ws.root();
                  if (!dir) return;
                  void props.ws.canWrite(dir).then((ok) => {
                    if (ok) props.ws.setCreating({ dir, kind: 'file' });
                    else toast('error', 'Cannot create', `${dir} 不可写`);
                  });
                }}
              >
                <Icon name="file" size={15} />
              </button>
              <button
                class="icon-btn"
                title="New folder"
                onClick={() => {
                  const dir = props.ws.root();
                  if (!dir) return;
                  void props.ws.canWrite(dir).then((ok) => {
                    if (ok) props.ws.setCreating({ dir, kind: 'dir' });
                    else toast('error', 'Cannot create', `${dir} 不可写`);
                  });
                }}
              >
                <Icon name="folder" size={15} />
              </button>
              <button
                class="icon-btn"
                title="Open Folder…"
                onClick={() =>
                  void props.ws.pickFolder().then((ok) => {
                    if (ok) toast('ok', 'Folder opened', props.ws.rootName());
                  })
                }
              >
                <Icon name="folderPlus" size={15} />
              </button>
            </Match>
            <Match when={view() === 'search'}>
              <button class="icon-btn" title="Clear" onClick={() => toast('info', 'Search cleared')}>
                <Icon name="x" size={15} />
              </button>
            </Match>
            <Match when={view() === 'changes'}>
              <button class="icon-btn" title="Refresh" onClick={() => toast('info', 'Index refreshed')}>
                <Icon name="refresh" size={15} />
              </button>
            </Match>
          </Switch>
          <button
            class="icon-btn"
            title="More"
            onClick={(e) =>
              openMenu(
                e.clientX,
                e.clientY,
                view() === 'files'
                  ? [
                      { label: 'Expand All', run: () => setTreeCmd({ kind: 'expand-all' }) },
                      { label: 'Collapse All', run: () => setTreeCmd({ kind: 'collapse-all' }) },
                      { separator: true, label: '' },
                      { label: 'Copy Workspace Path', run: () => void copyText('/home/zhuhongjing/researchgo', 'Workspace path copied') },
                    ]
                  : [
                      { label: 'Clear Results', run: () => toast('info', 'Cleared') },
                      { label: 'Search in Selection', disabled: true },
                    ],
              )
            }
          >
            <Icon name="more" size={15} />
          </button>
        </div>
      </div>

      <div class="explorer__body">
        <Switch>
          <Match when={view() === 'files'}>
            <FileTree ws={props.ws} />
          </Match>
          <Match when={view() === 'search'}>
            <SearchPanel ws={props.ws} />
          </Match>
          <Match when={view() === 'changes'}>
            <ChangesPanel ws={props.ws} />
          </Match>
        </Switch>
      </div>

      <Show when={view() === 'files' && props.ws.root()}>
        <div class="explorer__foot">
          <Icon name="folder" size={12} class="explorer__branch" />
          <span class="truncate">{props.ws.rootName()}</span>
          <span class="explorer__dot" />
          {/* Files in the directories the tree has actually listed — nothing here
              walks the project, so the number grows with what you look at and "+"
              means "at least this many". */}
          <Show when={props.ws.fileCount() !== null} fallback={<span>listing…</span>}>
            <span>
              {props.ws.fileCount()!.toLocaleString()}
              {props.ws.countTruncated() ? '+' : ''} files listed
            </span>
          </Show>
        </div>
      </Show>
    </aside>
  );
}
