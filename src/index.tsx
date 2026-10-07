import { render } from 'solid-js/web';

import App from './app';
import { toast } from './store/ui';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/explorer.css';
import './styles/stage.css';
import './styles/agent.css';
import './styles/overlays.css';

// Uncaught errors used to vanish: the UI simply stopped responding with no
// explanation, which cost hours of guessing. Surface them where they can be seen.
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => {
    toast('error', 'Unexpected error', String(e.error ?? e.message));
  });
  window.addEventListener('unhandledrejection', (e) => {
    toast('error', 'Operation failed', String(e.reason));
  });
}

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

render(() => <App />, root);
