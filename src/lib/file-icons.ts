import file from 'material-icon-theme/icons/file.svg';
import folder from 'material-icon-theme/icons/folder.svg';
import folderOpen from 'material-icon-theme/icons/folder-open.svg';
import bibliography from 'material-icon-theme/icons/bibliography.svg';
import consoleIcon from 'material-icon-theme/icons/console.svg';
import css from 'material-icon-theme/icons/css.svg';
import database from 'material-icon-theme/icons/database.svg';
import docker from 'material-icon-theme/icons/docker.svg';
import document from 'material-icon-theme/icons/document.svg';
import git from 'material-icon-theme/icons/git.svg';
import go from 'material-icon-theme/icons/go.svg';
import html from 'material-icon-theme/icons/html.svg';
import javascript from 'material-icon-theme/icons/javascript.svg';
import json from 'material-icon-theme/icons/json.svg';
import lock from 'material-icon-theme/icons/lock.svg';
import makefile from 'material-icon-theme/icons/makefile.svg';
import markdown from 'material-icon-theme/icons/markdown.svg';
import mdx from 'material-icon-theme/icons/mdx.svg';
import nodejs from 'material-icon-theme/icons/nodejs.svg';
import npm from 'material-icon-theme/icons/npm.svg';
import pdf from 'material-icon-theme/icons/pdf.svg';
import python from 'material-icon-theme/icons/python.svg';
import react from 'material-icon-theme/icons/react.svg';
import reactTs from 'material-icon-theme/icons/react_ts.svg';
import readme from 'material-icon-theme/icons/readme.svg';
import ruby from 'material-icon-theme/icons/ruby.svg';
import rust from 'material-icon-theme/icons/rust.svg';
import sass from 'material-icon-theme/icons/sass.svg';
import svg from 'material-icon-theme/icons/svg.svg';
import tex from 'material-icon-theme/icons/tex.svg';
import toml from 'material-icon-theme/icons/toml.svg';
import tsconfig from 'material-icon-theme/icons/tsconfig.svg';
import tune from 'material-icon-theme/icons/tune.svg';
import typescript from 'material-icon-theme/icons/typescript.svg';
import vite from 'material-icon-theme/icons/vite.svg';
import xml from 'material-icon-theme/icons/xml.svg';
import yaml from 'material-icon-theme/icons/yaml.svg';

import folderDist from 'material-icon-theme/icons/folder-dist.svg';
import folderDistOpen from 'material-icon-theme/icons/folder-dist-open.svg';
import folderDocs from 'material-icon-theme/icons/folder-docs.svg';
import folderDocsOpen from 'material-icon-theme/icons/folder-docs-open.svg';
import folderGit from 'material-icon-theme/icons/folder-git.svg';
import folderGitOpen from 'material-icon-theme/icons/folder-git-open.svg';
import folderGithub from 'material-icon-theme/icons/folder-github.svg';
import folderGithubOpen from 'material-icon-theme/icons/folder-github-open.svg';
import folderNode from 'material-icon-theme/icons/folder-node.svg';
import folderNodeOpen from 'material-icon-theme/icons/folder-node-open.svg';
import folderPublic from 'material-icon-theme/icons/folder-public.svg';
import folderPublicOpen from 'material-icon-theme/icons/folder-public-open.svg';
import folderResource from 'material-icon-theme/icons/folder-resource.svg';
import folderResourceOpen from 'material-icon-theme/icons/folder-resource-open.svg';
import folderScripts from 'material-icon-theme/icons/folder-scripts.svg';
import folderScriptsOpen from 'material-icon-theme/icons/folder-scripts-open.svg';
import folderSrc from 'material-icon-theme/icons/folder-src.svg';
import folderSrcOpen from 'material-icon-theme/icons/folder-src-open.svg';
import folderTest from 'material-icon-theme/icons/folder-test.svg';
import folderTestOpen from 'material-icon-theme/icons/folder-test-open.svg';

/**
 * A deliberately small, locally bundled slice of Material Icon Theme.
 *
 * File-name matches win over extensions, just as they do in VS Code. Keeping
 * this table explicit means Vite only emits icons the application can show;
 * the theme's thousand-plus SVGs never become part of the desktop bundle.
 */
const FILE_NAMES: Record<string, string> = {
  'package.json': nodejs,
  'package-lock.json': nodejs,
  'npm-shrinkwrap.json': npm,
  'vite.config.js': vite,
  'vite.config.mjs': vite,
  'vite.config.ts': vite,
  'vite.config.mts': vite,
  'tsconfig.json': tsconfig,
  'jsconfig.json': tsconfig,
  'dockerfile': docker,
  'makefile': makefile,
  '.gitignore': git,
  '.gitattributes': git,
  '.gitmodules': git,
  '.env': tune,
  'readme': readme,
  'readme.md': readme,
  'readme.mdx': readme,
};

const FILE_EXTENSIONS: Record<string, string> = {
  tsx: reactTs,
  jsx: react,
  ts: typescript,
  mts: typescript,
  cts: typescript,
  js: javascript,
  mjs: javascript,
  cjs: javascript,
  rs: rust,
  json: json,
  jsonc: json,
  css: css,
  scss: sass,
  sass: sass,
  html: html,
  htm: html,
  svg: svg,
  xml: xml,
  yml: yaml,
  yaml: yaml,
  toml: toml,
  md: markdown,
  markdown: markdown,
  mdx: mdx,
  tex: tex,
  sty: tex,
  bib: bibliography,
  py: python,
  rb: ruby,
  go: go,
  sh: consoleIcon,
  bash: consoleIcon,
  zsh: consoleIcon,
  ps1: consoleIcon,
  sql: database,
  pdf: pdf,
  txt: document,
  log: document,
  lock: lock,
  env: tune,
};

interface FolderPair {
  closed: string;
  open: string;
}

const FOLDERS: Record<string, FolderPair> = {
  src: { closed: folderSrc, open: folderSrcOpen },
  source: { closed: folderSrc, open: folderSrcOpen },
  test: { closed: folderTest, open: folderTestOpen },
  tests: { closed: folderTest, open: folderTestOpen },
  docs: { closed: folderDocs, open: folderDocsOpen },
  doc: { closed: folderDocs, open: folderDocsOpen },
  '.git': { closed: folderGit, open: folderGitOpen },
  '.github': { closed: folderGithub, open: folderGithubOpen },
  node_modules: { closed: folderNode, open: folderNodeOpen },
  public: { closed: folderPublic, open: folderPublicOpen },
  dist: { closed: folderDist, open: folderDistOpen },
  build: { closed: folderDist, open: folderDistOpen },
  assets: { closed: folderResource, open: folderResourceOpen },
  resources: { closed: folderResource, open: folderResourceOpen },
  scripts: { closed: folderScripts, open: folderScriptsOpen },
};

export function baseNameOf(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
}

export function fileIconOf(path: string): string {
  const name = baseNameOf(path);
  const exact = FILE_NAMES[name];
  if (exact) return exact;

  // Trying every suffix preserves compound-extension support when more of the
  // upstream theme is added (for example `d.ts` before plain `ts`).
  const parts = name.split('.');
  for (let i = 1; i < parts.length; i++) {
    const match = FILE_EXTENSIONS[parts.slice(i).join('.')];
    if (match) return match;
  }
  return file;
}

export function folderIconOf(path: string, expanded = false): string {
  const pair = FOLDERS[baseNameOf(path)];
  if (pair) return expanded ? pair.open : pair.closed;
  return expanded ? folderOpen : folder;
}
