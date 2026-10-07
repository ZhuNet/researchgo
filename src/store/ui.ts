import { createSignal } from 'solid-js';

export type Theme = 'dark' | 'light';

export interface Toast {
  id: number;
  kind: 'info' | 'ok' | 'error';
  title: string;
  detail?: string;
}

const stored = (typeof localStorage !== 'undefined' && localStorage.getItem('rg.theme')) as Theme | null;

const [theme, setThemeSignal] = createSignal<Theme>(stored ?? 'dark');
export { theme };

export function setTheme(next: Theme) {
  setThemeSignal(next);
  if (typeof localStorage !== 'undefined') localStorage.setItem('rg.theme', next);
  document.documentElement.dataset.theme = next;
}

export function applyStoredTheme() {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme();
}

const ls = typeof localStorage !== 'undefined' ? localStorage : null;

function read<T>(key: string, fallback: T, validate: (raw: unknown) => boolean): T {
  const raw = ls?.getItem(key);
  if (raw === null || raw === undefined) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return validate(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  ls?.setItem(key, JSON.stringify(value));
}

const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const bool = (v: unknown) => typeof v === 'boolean';
const oneOf =
  <T extends string>(...allowed: T[]) =>
  (v: unknown) =>
    typeof v === 'string' && (allowed as string[]).includes(v);

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export const [explorerW, setExplorerWRaw] = createSignal(
  clamp(read('rg.explorerW', 268, num), 200, 560),
);
export const [agentW, setAgentWRaw] = createSignal(clamp(read('rg.agentW', 400, num), 320, 720));
export const [agentCollapsed, setAgentCollapsedRaw] = createSignal(
  read('rg.agentCollapsed', false, bool),
);
export const [railView, setRailViewRaw] = createSignal<'files' | 'search' | 'changes'>(
  read('rg.railView', 'files', oneOf('files', 'search', 'changes')),
);
export const [paletteOpen, setPaletteOpen] = createSignal(false);
export const [paletteQuery, setPaletteQuery] = createSignal('');
export const [menu, setMenu] = createSignal<{ x: number; y: number; items: MenuItem[] } | null>(
  null,
);
export const [toasts, setToasts] = createSignal<Toast[]>([]);
export const [treeCmd, setTreeCmd] = createSignal<{ kind: 'expand-all' | 'collapse-all' } | null>(
  null,
);
export const [wrap, setWrapRaw] = createSignal(read('rg.wrap', false, bool));

export function setExplorerW(next: number) {
  const value = clamp(next, 200, 560);
  setExplorerWRaw(value);
  write('rg.explorerW', value);
}

export function setAgentW(next: number) {
  const value = clamp(next, 320, 720);
  setAgentWRaw(value);
  write('rg.agentW', value);
}

export function setAgentCollapsed(next: boolean) {
  setAgentCollapsedRaw(next);
  write('rg.agentCollapsed', next);
}

export function setRailView(next: 'files' | 'search' | 'changes') {
  setRailViewRaw(next);
  write('rg.railView', next);
}

export function setWrap(next: boolean) {
  setWrapRaw(next);
  write('rg.wrap', next);
}

let seq = 0;

export function toast(kind: Toast['kind'], title: string, detail?: string) {
  const id = ++seq;
  setToasts((prev) => [...prev.slice(-3), { id, kind, title, detail }]);
  setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 2600);
}

export interface MenuItem {
  label: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  run?: () => void;
}

export function openMenu(x: number, y: number, items: MenuItem[]) {
  setMenu({ x, y, items });
}

export function closeMenu() {
  setMenu(null);
}

export async function copyText(text: string, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast('ok', label, text);
    return true;
  } catch {
    toast('error', 'Clipboard unavailable', text);
    return false;
  }
}
