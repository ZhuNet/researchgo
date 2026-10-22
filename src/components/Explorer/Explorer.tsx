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
        <h2
          class="explorer__title"
          data-tooltip={view() === 'files' && props.ws.root()
            ? props.ws.fileCount() === null
              ? 'listing…'
              : `${props.ws.fileCount()!.toLocaleString()}${props.ws.countTruncated() ? '+' : ''} files listed`
            : undefined}
        >
          {TITLES[view()]}
        </h2>
        <div class="explorer__actions">
          <Switch>
            <Match when={view() === 'files'}>
              <button
                class="icon-btn"
                aria-label="Open Folder…"
                data-tooltip="Open Folder…"
                onClick={() =>
                  void props.ws.pickFolder().then((ok) => {
                    if (ok) toast('ok', 'Folder opened', props.ws.rootName());
                  })
                }
              >
                <Icon name="folder" size={15} />
              </button>
              <button
                class="icon-btn"
                aria-label="New file"
                data-tooltip="New file  ⌘N"
                onClick={() => void props.ws.startCreating('file')}
              >
                <Icon name="filePlus" size={15} />
              </button>
              <button
                class="icon-btn"
                aria-label="New folder"
                data-tooltip="New folder"
                onClick={() => void props.ws.startCreating('dir')}
              >
                <Icon name="folderPlus" size={15} />
              </button>
            </Match>
            <Match when={view() === 'search'}>
              <button class="icon-btn" aria-label="Clear" data-tooltip="Clear" onClick={() => toast('info', 'Search cleared')}>
                <Icon name="x" size={15} />
              </button>
            </Match>
            <Match when={view() === 'changes'}>
              <button class="icon-btn" aria-label="Refresh" data-tooltip="Refresh" onClick={() => toast('info', 'Index refreshed')}>
                <Icon name="refresh" size={15} />
              </button>
            </Match>
          </Switch>
          <button
            class="icon-btn"
            aria-label="More"
            data-tooltip="More"
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
        <div class="explorer__foot" data-tooltip={props.ws.root() ?? undefined}>
          <Icon name="folder" size={12} class="explorer__branch" />
          <span class="truncate">{props.ws.root()}</span>
        </div>
      </Show>
    </aside>
  );
}
