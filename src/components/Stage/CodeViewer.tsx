import { createMemo, Match, Switch } from 'solid-js';

import { Icon } from '../Icon';
import type { Workspace } from '../../store/workspace';
import { MonacoText } from './MonacoText';

/**
 * Text view, which is one of three things depending on the file.
 *
 * A probe decides before any content is read: text files get the editor, files too
 * large to hold in memory are reported as such, and anything that is not text at
 * all gets told so instead of being rendered as replacement characters.
 */
export function CodeViewer(props: { ws: Workspace; path: string }) {
  const mode = createMemo(() => {
    props.ws.editor.revision();
    return props.ws.editor.modeOf(props.path);
  });

  return (
    <Switch>
      <Match when={mode() === 'binary'}>
        <Unshowable
          title="File is not displayed as text"
          path={props.path}
          detail={
            props.ws.editor.reasonOf(props.path) ??
            'It contains bytes that are not text, so there is nothing to show. Opening it in another application is usually the fastest route.'
          }
        />
      </Match>
      <Match when={mode() === 'oversized'}>
        <Unshowable
          title="File is too large to open"
          path={props.path}
          detail={
            props.ws.editor.reasonOf(props.path) ??
            'It is larger than the editor can hold in memory.'
          }
        />
      </Match>
      <Match when={mode() === 'missing'}>
        <Unshowable
          title="File could not be read"
          path={props.path}
          detail={props.ws.editor.reasonOf(props.path) ?? 'The file is gone or unreadable.'}
        />
      </Match>
      <Match when={true}>
        <MonacoText ws={props.ws} path={props.path} />
      </Match>
    </Switch>
  );
}

/**
 * Says plainly that there is nothing to draw.
 *
 * The alternative — decode it anyway and show mojibake, or an empty page — reads
 * as a broken editor rather than as a file that cannot be a text file.
 */
function Unshowable(props: { title: string; path: string; detail: string }) {
  return (
    <div class="viewer viewer--notice">
      <div class="notice">
        <div class="notice__icon">
          <Icon name="file" size={22} />
        </div>
        <h2 class="notice__title">{props.title}</h2>
        <p class="notice__path">{props.path}</p>
        <p class="notice__detail">{props.detail}</p>
      </div>
    </div>
  );
}
