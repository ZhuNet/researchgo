import { fileGlyphOf, fileIconLang } from '../lib/fs';

const P: Record<string, string> = {
  chevronRight: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
  chevronDown: '<path d="M5.5 9.5 12 16l6.5-6.5"/>',
  chevronUpDown: '<path d="M8 9.5 12 5.5l4 4M8 14.5l4 4 4-4"/>',
  folder:
    '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h3.3a1.5 1.5 0 0 1 1.1.5l1.2 1.4H19.5A1.5 1.5 0 0 1 21 9.4v9.1A1.5 1.5 0 0 1 19.5 20h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  folderPlus:
    '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h3.3a1.5 1.5 0 0 1 1.1.5l1.2 1.4H19.5A1.5 1.5 0 0 1 21 9.4v9.1A1.5 1.5 0 0 1 19.5 20h-15A1.5 1.5 0 0 1 3 18.5z"/><path d="M12 11v6M9 14h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>',
  folderOpen:
    '<path d="M3 8.4V7.5A1.5 1.5 0 0 1 4.5 6h3.3a1.5 1.5 0 0 1 1.1.5l1.2 1.4h8.4A1.5 1.5 0 0 1 20 9.4v.6"/><path d="M3.3 10h17.2a.9.9 0 0 1 .87 1.15l-1.6 6.3a1.5 1.5 0 0 1-1.46 1.13H5.3a1.5 1.5 0 0 1-1.46-1.13l-1.4-5.5A.9.9 0 0 1 3.3 10z"/>',
  file:
    '<path d="M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9A1.5 1.5 0 0 0 18 19.5V7z"/><path d="M14 3v4.5h4"/>',
  fileText:
    '<path d="M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9A1.5 1.5 0 0 0 18 19.5V7z"/><path d="M14 3v4.5h4M9 13h6M9 16.5h4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.2-4.2"/>',
  branch:
    '<circle cx="6.5" cy="5.5" r="2.5"/><circle cx="6.5" cy="18.5" r="2.5"/><circle cx="17.5" cy="9.5" r="2.5"/><path d="M6.5 8v8M17.5 12c0 3.6-3 4.6-6 5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  trash:
    '<path d="M4 7h16M10 11.5v5M14 11.5v5"/><path d="M6.5 7 7.4 19a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/><path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/>',
  pencil: '<path d="M12.5 20.5H21"/><path d="M16.4 3.9a2.1 2.1 0 0 1 3 3L8.2 18.1 4 19.2l1.1-4.2z"/>',
  copy:
    '<rect x="9" y="9" width="11.5" height="11.5" rx="2"/><path d="M5.5 15H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5h8.5A1.5 1.5 0 0 1 15 5v.5"/>',
  clipboard:
    '<rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 5V4a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 4v1z"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4.5V10h-5.5"/>',
  check: '<path d="m20 6.5-11 11-4.5-4.5"/>',
  alert: '<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/>',
  moon: '<path d="M20.5 14.3A8.6 8.6 0 0 1 9.7 3.5a8.6 8.6 0 1 0 10.8 10.8z"/>',
  panelLeft: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M9.5 4.5v15"/>',
  panelRight: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M14.5 4.5v15"/>',
  columns: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M12 4.5v15"/>',
  code: '<path d="M9 8 5 12l4 4M15 8l4 4-4 4"/>',
  book: '<path d="M6 3.5h8.5L19 8v11.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z"/><path d="M14.5 3.5V8H19"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  more: '<circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/>',
  arrowUp: '<path d="M12 19.5V5M6.5 10.5 12 5l5.5 5.5"/>',
  arrowRight: '<path d="M4.5 12h14M13 6.5l5.5 5.5-5.5 5.5"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  play: '<path d="M8 5.5 18.5 12 8 18.5z"/>',
  sparkles:
    '<path d="m11 3 1.7 4.6L17.5 9.3l-4.8 1.7L11 15.6 9.3 11 4.5 9.3l4.8-1.7z"/><path d="m18 14.5.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z"/>',
  sliders: '<path d="M4 7h9M17.5 7H20M4 12h3.5M12 12h8M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9.5" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
  cornerDownLeft: '<path d="M9 10 5 14l4 4"/><path d="M5 14h11a4 4 0 0 0 4-4V5.5"/>',
  external: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 3 18.5v-12A1.5 1.5 0 0 1 4.5 5H9"/>',
  save: '<path d="M4.5 4.5h11L19.5 8.5v11a1 1 0 0 1-1 1h-14a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1z"/><path d="M8 4.5v5h7v-5M8 20.5V15h8v5.5"/>',
  wrapText: '<path d="M4 6h16M4 11.5h11a3.5 3.5 0 0 1 0 7h-2.5M4 18.5h5"/><path d="m15 16-2.5 2.5L15 21"/>',
  terminal: '<path d="m5 7.5 4 4-4 4M12 16.5h7"/>',
  cpu: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/><rect x="10" y="10" width="4" height="4" rx="1"/><path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3"/>',
  zap: '<path d="M13.5 2.5 5 13.5h6l-.5 8 8.5-11h-6z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  layers: '<path d="m12 3 8.5 4.5L12 12 3.5 7.5z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5"/>',
  hash: '<path d="M5 9.5h14M4 14.5h14M10.5 4 8 20M16 4l-2.5 16"/>',
  maximize: '<path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15"/>',
  restore: '<rect x="4.5" y="7.5" width="12" height="12" rx="1.6"/><path d="M8 7.5V6a1.5 1.5 0 0 1 1.5-1.5H18A1.5 1.5 0 0 1 19.5 6v8.5A1.5 1.5 0 0 1 18 16h-1.5"/>',
  filter: '<path d="M4 5.5h16l-6 7.5v6l-4 2v-8z"/>',
  inbox: '<path d="M3.5 13.5 6 5.5h12l2.5 8v5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M3.5 13.5h4l1 2.5h7l1-2.5h4"/>',
  diff: '<path d="M7 4v13M7 4 4 7.5M7 4l3 3.5M7 17l-3 3M7 17l3 3M17 20V7M17 20l-3-3.5M17 20l3-3.5M17 7l-3-3M17 7l3-3"/>',
  listTree: '<path d="M5 6h4M5 12h4M5 18h4M11.5 6H19M11.5 12H19M11.5 18H19"/>',
  dot: '<circle cx="12" cy="12" r="3.2"/>',
  send: '<path d="M12 19.5V5M6.5 10.5 12 5l5.5 5.5"/>',
  paperclip:
    '<path d="M17.5 11.5 11 18a3.5 3.5 0 0 1-5-5l7-7a2.5 2.5 0 0 1 3.5 3.5l-7 7a1.5 1.5 0 0 1-2-2l6-6"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.2 2.4 3.3 5.4 3.3 8.5S14.2 18.1 12 20.5c-2.2-2.4-3.3-5.4-3.3-8.5S9.8 5.9 12 3.5z"/>',
};

export type IconName = keyof typeof P | string;

/**
 * The file-type glyph for a path: one glyph mapping, one color table, one
 * look. Every place that shows a file's type icon — tree rows, tabs, search
 * results — renders this, so a new file kind is added exactly once.
 */
export function FileGlyph(props: { path: string; size?: number }) {
  return (
    <Icon
      name={fileGlyphOf(props.path)}
      size={props.size ?? 14}
      class="row__glyph"
      style={{ color: LANG_COLOR[fileIconLang(props.path)] }}
    />
  );
}

export function Icon(props: {
  name: IconName;
  size?: number;
  class?: string;
  stroke?: number;
  style?: Record<string, string | number>;
}) {
  const size = () => props.size ?? 16;
  return (
    <svg
      class={props.class}
      style={props.style}
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={props.stroke ?? 1.6}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      innerHTML={P[props.name] ?? P.dot}
    />
  );
}

export const LANG_COLOR: Record<string, string> = {
  ts: '#3178c6',
  tsx: '#3178c6',
  js: '#eab308',
  jsx: '#eab308',
  rs: '#dea584',
  json: '#a371f7',
  css: '#42a5f5',
  scss: '#f55385',
  html: '#e34c26',
  xml: '#e37933',
  yaml: '#cb9f4a',
  toml: '#9c4221',
  md: '#7d8590',
  mdx: '#7d8590',
  tex: '#3f8fd6',
  bib: '#8a7f5c',
  py: '#3572a5',
  sh: '#4e9a51',
  docker: '#0f8ecb',
  txt: '#8b9098',
  env: '#c8a84b',
  sql: '#d38f6d',
  go: '#00add8',
  pdf: '#d9381e',
};
