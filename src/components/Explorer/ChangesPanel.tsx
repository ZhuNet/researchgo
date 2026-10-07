import { createMemo, For, Show } from 'solid-js';

import { Icon } from '../Icon';
import { basenameOf } from '../../lib/rowindex';
import { toast } from '../../store/ui';
import type { Workspace } from '../../store/workspace';

/**
 * With a real filesystem on disk we do not yet know git state — that needs a
 * `git status --porcelain` command on the Rust side. Until then this panel shows
 * what is actually knowable and actionable: buffers edited in the editor but not
 * written back to disk.
 */
export function ChangesPanel(props: { ws: Workspace }) {
  const ws = () => props.ws;
  const root = () => ws().root() ?? '/';

  const files = createMemo(() =>
    [...ws().dirty()].sort().map((path) => ({
      path,
      name: basenameOf(path, root()),
      dir: path.slice(0, path.length - basenameOf(path, root()).length - 1) || root(),
    })),
  );

  return (
    <div class="panel">
      <div class="scroll panel__body">
        <Show
          when={files().length > 0}
          fallback={
            <div class="panel__empty">
              <Icon name="check" size={22} />
              <p>No unsaved changes</p>
              <span>Edits you make in the editor show up here</span>
            </div>
          }
        >
          <div class="changes__summary">
            <div class="changes__bar">
              <span class="changes__seg changes__seg--rest" style={{ width: '100%' }} />
            </div>
            <span class="changes__count">{files().length} unsaved</span>
          </div>

          <div class="changes__group">
            <div class="changes__groupline">
              <Icon name="chevronDown" size={12} />
              <span>Modified</span>
              <span class="changes__num">{files().length}</span>
            </div>
            <For each={files()}>
              {(file) => (
                <div class="change">
                  <button class="change__open" onClick={() => void ws().openFile(file.path)}>
                    <Icon name="file" size={13} class="row__glyph" />
                    <span class="truncate">{file.name}</span>
                    <span class="change__path truncate">{file.dir}</span>
                    <span class="change__status">M</span>
                  </button>
                  <button
                    class="change__save"
                    title="Write to disk"
                    onClick={() => {
                      const text = ws().contentOf(file.path);
                      void ws()
                        .saveFile(file.path, text)
                        .then(() => toast('ok', 'Saved', file.path))
                        .catch((err: unknown) =>
                          toast('error', 'Save failed', String(err)),
                        );
                    }}
                  >
                    <Icon name="save" size={13} />
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div class="panel__footer">
        <button
          class="btn btn--outline"
          style={{ flex: 1 }}
          disabled={files().length === 0}
          onClick={() => {
            for (const file of files()) void ws().openFile(file.path);
          }}
        >
          Review
        </button>
        <button
          class="btn btn--solid"
          style={{ flex: 1 }}
          disabled={files().length === 0}
          onClick={() => {
            const pending = files();
            void Promise.all(
              pending.map((file) => ws().saveFile(file.path, ws().contentOf(file.path))),
            ).then(() => toast('ok', 'Saved', `${pending.length} files`));
          }}
        >
          Save all
        </button>
      </div>
    </div>
  );
}