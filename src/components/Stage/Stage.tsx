import { createMemo, Match, Show, Switch } from 'solid-js';

import { Icon } from '../Icon';
import { toast } from '../../store/ui';
import type { Workspace } from '../../store/workspace';
import { CodeViewer } from './CodeViewer';
import { PdfViewer } from './PdfViewer';
import { TabBar } from './TabBar';

export function Stage(props: { ws: Workspace }) {
  const ws = () => props.ws;
  const activePath = () => ws().active();

  /**
   * The tab being read.
   *
   * A PDF is deliberately included: opening one from the tree does not preview it,
   * it reports that a PDF is not text. The preview is a separate mode, reached from
   * the titlebar or the palette, and it shows what the project compiled.
   */
  const codePath = createMemo(() => activePath());

  return (
    <section class="stage">
      <TabBar ws={ws()} />

      <div class="stage__body" classList={{ 'stage__body--split': ws().stageMode() === 'split' }}>
        <Switch>
          <Match when={ws().stageMode() === 'pdf'}>
            <PdfViewer ws={ws()} />
          </Match>
          <Match when={ws().stageMode() === 'split'}>
            <div class="stage__pane">
              <Show when={codePath()} fallback={<EmptyStage ws={ws()} />}>
                {(p) => <CodeViewer ws={ws()} path={p()} />}
              </Show>
            </div>
            <div class="stage__pane">
              <PdfViewer ws={ws()} />
            </div>
          </Match>
          <Match when={true}>
            <div class="stage__pane">
              <Show
                when={activePath()}
                fallback={<EmptyStage ws={ws()} />}
              >
                {(p) => <CodeViewer ws={ws()} path={p()} />}
              </Show>
            </div>
          </Match>
        </Switch>
      </div>
    </section>
  );
}

function EmptyStage(props: { ws: Workspace }) {
  return (
    <div class="empty">
      <div class="empty__mark">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path
            d="M3.5 7.2A3.2 3.2 0 0 1 6.7 4h3.1l2 2.4h5.5A3.2 3.2 0 0 1 20.5 9.6v7.2a3.2 3.2 0 0 1-3.2 3.2H6.7a3.2 3.2 0 0 1-3.2-3.2z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linejoin="round"
          />
        </svg>
      </div>
      <h2>ResearchGO</h2>

      <Show
        when={props.ws.root()}
        fallback={
          <>
            <p>Open a folder to browse it. The tree loads lazily, so huge repositories stay smooth.</p>
            <button
              class="btn btn--solid"
              onClick={() =>
                void props.ws.pickFolder().then((ok) => {
                  if (ok) toast('ok', 'Folder opened', props.ws.rootName());
                })
              }
            >
              <Icon name="folder" size={14} />
              Open Folder…
            </button>
            <div class="empty__keys">
              <span>
                <span class="kbd">⌘K</span> command palette
              </span>
              <span>
                <span class="kbd">⌘B</span> toggle explorer
              </span>
              <span>
                <span class="kbd">⌘I</span> toggle agent
              </span>
            </div>
          </>
        }
      >
        <p>Select a file to start reading, or ask the agent to do it for you.</p>
        <div class="empty__keys">
          <span>
            <span class="kbd">⌘K</span> command palette
          </span>
          <span>
            <span class="kbd">⌘P</span> quick open
          </span>
          <span>
            <span class="kbd">⌘B</span> toggle explorer
          </span>
          <span>
            <span class="kbd">⌘I</span> toggle agent
          </span>
        </div>
        <Show when={props.ws.fileCount()}>
          <div class="empty__stats">
            <span>{props.ws.fileCount()!.toLocaleString()} files listed</span>
            <span class="empty__dot" />
            <span>sidecar connected</span>
          </div>
        </Show>
      </Show>
    </div>
  );
}
