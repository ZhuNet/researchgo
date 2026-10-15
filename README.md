<div align="center">

<img src="docs/banner.svg" alt="ResearchGO" width="100%" />

# ResearchGO

**A local-first research workspace for people who write papers.**
Edit the `.tex`, hit build, read the PDF in the same window — with a coding agent
that is sandboxed to the folder you actually opened.

[![License: BSD 2-Clause](https://img.shields.io/badge/License-BSD%202--Clause-3b6ea8?style=flat-square)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.12-24c8db?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app)
[![SolidJS](https://img.shields.io/badge/SolidJS-1.9-2c4f7c?style=flat-square&logo=solid&logoColor=white)](https://www.solidjs.com)
[![Rust](https://img.shields.io/badge/Rust-2024%20edition-dca282?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org)
[![Offline](https://img.shields.io/badge/network-outbound-none-10b981?style=flat-square)](#security--privacy)
[![Tests](https://img.shields.io/badge/tests-223%20TS%20%2B%20103%20Rust-1f7a5c?style=flat-square)](#testing)]

[**Quick start**](#quick-start) · [**Features**](#features) · [**Shortcuts**](#keyboard-shortcuts) · [**Architecture**](#architecture) · [**Stack**](#tech-stack)

</div>

---

## The idea

Most paper writing is spread across four windows: a code editor, a terminal running
`latexmk`, a PDF viewer, and a chat tab where you paste context into a model. They
disagree with each other. The editor doesn't know the PDF changed. The model doesn't
know what your build printed. The viewer loses your place when you switch papers.

ResearchGO is one window that knows all of it is the same project.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ ● paper.tex       figures       main.pdf      ⟨ Source │ Preview │ Split ⟩       │
├──────────────────┬───────────────────────────────────────────────────────────────┤
│ ▾ src/           │   \documentclass{article}                                     │
│   intro.tex      │                                      ╭────────────────────╮   │
│ ▾ figures/       │   \begin{document}                                            │
│   plot.pdf       │                                      │                    │   │
│ ▾ .rg/           │   \input{src/intro}                   │                    │  │
│   build/         │   % rebuild to see it                │      Preview       │   │
│                  │   \end{document}                      │                    │  │
│                  │                                      ╰────────────────────╯   │
├──────────────────┴───────────────────────────────────────────────────────────────┤
│  Search · Changes · Agent · Settings                     ⌘K   ◐  ⌄               │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Three things it does that the usual four-window setup does not:

- **The preview compiles your project.** Not "open a PDF" — it runs XeLaTeX over the
  folder you have open, twice, so the TOC and cross-references are right, and renders
  the artifact in a full pdf.js viewer with your reading position and zoom preserved
  across rebuilds.
- **The agent is confined to your project.** Every path it touches is resolved inside
  the folder you opened. `../..` is refused, not warned about. The renderer has no
  network permission at all.
- **The tree is built for real directories.** Paged listings with an on-disk sort,
  virtualized rows, prefetch-on-hover. A `node_modules` with 200k entries opens
  without the UI ever holding 200k rows in memory.

---

## Features

<table>
<tr>
<td width="50%" valign="top" align="left">

<h3>🗂 &nbsp;Workspace</h3>

<ul>
<li><strong>Paged directory index</strong> — the Rust side sorts on disk with an external merge sort and serves 512 entries at a time, so a 500k-entry directory pages instead of choking.</li>
<li><strong>Virtualized tree</strong> — windowed rows with overscan, no depth cap, anchored on the topmost visible <em>row</em> so expanding above the viewport never makes the tree flinch.</li>
<li><strong>Prefetch on hover</strong> — a 150&nbsp;ms dwell fetches the next page, so expanding never shows a “loading…” flash.</li>
<li><strong>Memory ceilings</strong> — a 200k-entry / 2000-directory FIFO cache with pins for the active, dirty and missing paths. Evict something and it comes back clean.</li>
<li><strong>Drag &amp; drop</strong> — move rows with pointer capture; dwell 600&nbsp;ms on a collapsed folder to expand it mid-drag; <code>Esc</code> aborts. Drop folders <em>from the OS</em> into the workspace to copy them in, with collision renaming.</li>
<li><strong>Live disk sync</strong> — one multiplexed <code>notify</code> watcher. Events patch memory immediately and coalesce re-reads behind a 120&nbsp;ms quiet window, so a thousand build events cause one read, not a thousand.</li>
<li><strong>Full-text search</strong> — runs on the host over the whole workspace with fuzzy ranking, not just your open tabs.</li>
</ul>

<h3>✍️ &nbsp;Editor</h3>

<ul>
<li><strong>Monaco</strong>, with <strong>Shiki</strong> grammars bridged in through <code>@shikijs/monaco</code>.</li>
<li>22 lazily-loaded languages, including <code>latex</code> and <code>bibtex</code>.</li>
<li>Per-file models keyed by URI, disposed the moment no tab owns them.</li>
<li><strong>Byte-budgeted text residency</strong> — a 48&nbsp;MiB FIFO with pins, so switching tabs does not re-read a file you just had open.</li>
<li>Degrades gracefully: past 2&nbsp;Mi characters the minimap, folding, occurrence highlighting and whitespace decorations switch themselves off.</li>
<li>PDFs are classified as non-text by extension and never sniffed into the buffer.</li>
</ul>

</td>
<td width="50%" valign="top" align="left">

<h3>📄 &nbsp;Preview</h3>

<ul>
<li><strong>It compiles the project.</strong> XeLaTeX auto-detected, two passes, artifact written to <code>.rg/build/&lt;stem&gt;.pdf</code> at a deterministic path.</li>
<li><strong>Pre-flight toolchain check</strong> — if <code>xelatex</code> is not on <code>PATH</code>, the Build button is disabled <em>before</em> you click it, with the fix in the message.</li>
<li><strong>Refuses ambiguity.</strong> More than one <code>.tex</code> in the folder is an error, not a coin flip. Override it with <code>.rg/build.json</code> if you really want.</li>
<li><strong>A live <code>PATH</code>.</strong> On Windows the environment is read from the registry, not the process snapshot, and polled — install TeX Live while the app is open and the plan re-checks itself.</li>
<li><strong>Full pdf.js viewer</strong> — text layer, outline/thumbnails sidebar, find, zoom, print. The Build button is injected into pdf.js’s own toolbar and inherits its styles.</li>
<li><strong>You keep your place.</strong> Page, zoom and sidebar view survive a rebuild; the position is re-anchored to a page, not a pixel offset, so it survives the content shifting underneath it.</li>
<li><strong>Failure keeps the last good PDF on screen</strong> and marks the pane failed, so a broken build never wipes the page you were reading.</li>
<li>CMaps, standard fonts, wasm decoders and ICC profiles are bundled, so CID and CJK output from XeLaTeX renders as text instead of mojibake.</li>
</ul>

<h3>🤖 &nbsp;Agent</h3>

<ul>
<li><strong>A real backend loop</strong> against any OpenAI-compatible <code>/chat/completions</code>, with SSE streaming — tokens land in the transcript as they are written.</li>
<li><strong>Six tools</strong>: <code>read</code>, <code>write</code>, <code>edit</code>, <code>bash</code>, <code>glob</code>, <code>grep</code>.</li>
<li><code>glob</code> and <code>grep</code> run on <strong>ripgrep’s own Rust engine</strong> (<code>globset</code>, <code>grep-regex</code>, <code>grep-searcher</code>), honoring ignore files.</li>
<li><strong>Told which shell it is on.</strong> The tool description switches between <code>cmd /C</code> and <code>sh -c</code> so it does not guess your command syntax.</li>
<li><strong>A non-zero exit is a failed call with its output attached</strong>, not an exception.</li>
<li><strong>Stop is real.</strong> A watch channel races every await, so interrupting tears the turn down instead of waiting on a stream that will never end.</li>
<li><strong>Sandboxed to the workspace root</strong> — traversal outside it is refused in code, and there is a test that says so.</li>
<li><strong>Multi-endpoint config</strong> — named endpoints, several models each, switchable from the panel. Add, edit, activate, delete, with neighbour-fallback repair when the active pair goes away.</li>
<li>Your key never reaches the renderer. You get an <code>sk-ab…9f2c</code> fingerprint and nothing else.</li>
<li>Every turn is appended to a fan-out JSON log beside your config — rollback on failure, one retry, in original order.</li>
</ul>

</td>
</tr>
</table>

---

## Quick start

```bash
git clone https://github.com/ZhuNet/researchgo.git
cd researchgo
npm install          # also stages the pdf.js assets (cmaps, wasm, ICCs, toolbar icons)
npm run tauri:dev    # compiles the Rust host on first run — this takes a while
```

You need:

| | |
|---|---|
| **Node** | 22+ (developed on 24) |
| **Rust** | 1.90+ (edition 2024) |
| **LaTeX** | XeLaTeX on `PATH` — only for the Preview pane. TeX Live or MiKTeX is fine. |
| **A model endpoint** | Any OpenAI-compatible API. Add it in `⌘,` → Models. |

First launch will show an empty workspace. `Open Folder` picks a directory, or just
drag one in from your OS. A folder containing a single `.tex` file gets a live Build
button immediately.

### Running the pieces separately

```bash
npm run dev          # renderer only, http://localhost:5199 — no filesystem, no agent
npm run tauri:build  # bundle (deb / AppImage)
npm test             # 223 vitest cases, then 103 Rust tests
```

---

## Keyboard shortcuts

Everything is `⌘` on macOS, `Ctrl` elsewhere.

### Global

| | |
|---|---|
| `⌘K` / `⌘P` | Command palette & quick open |
| `⌘B` | Toggle explorer |
| `⌘I` | Toggle agent panel |
| `⌘⇧L` | Toggle dark / light |
| `⌘,` | Settings → Models |
| `⌘1` `⌘2` `⌘3` | Explorer · Search · Changes |

### Inside the app

| | |
|---|---|
| `⌘S` | Save the current file |
| `⌘W` | Close tab |
| `⌘N` | New file |
| `⏎` | Send (composer) · open row (tree) |
| `⇧⏎` | Newline in the composer |
| `↑` `↓` `→` `←` | Move the tree cursor; `→` expands or descends, `←` collapses or jumps to parent |
| `F2` / `Del` | Rename / delete the selected row |
| `Esc` | Cancel a rename, a create, or an in-flight drag |

---

## Architecture

```
src/                    SolidJS renderer — no framework in the hot paths
├─ app.tsx              layout shell, global shortcuts
├─ components/
│  ├─ Explorer/         FileTree (virtualized, DnD, keyboard) · Search · Changes
│  ├─ Stage/            TabBar · MonacoText · CodeViewer · PdfViewer
│  └─ Agent/            AgentPanel · AgentThread · Composer · ModelMenu
├─ lib/                 pure, unit-tested cores — Backend iface, DirCache, RowIndex,
│                       TextCache, tab window, pdf position, streaming markdown
├─ store/               workspace · editor · agent · ui state machines
└─ styles/              design tokens + per-surface CSS

src-tauri/src/          Rust host — the only place with real power
├─ lib.rs               27 Tauri commands
├─ dirindex.rs          paged listings + external merge sort + cache sweep
├─ content.rs           file probe, build planning, XeLaTeX execution
├─ fsops.rs             read/write/create/rename/remove/copy + writability probe
├─ search.rs            workspace full-text search
├─ watcher.rs           one multiplexed notify watcher
├─ toolchain.rs         PATH resolution, registry on Windows, live PATH poller
└─ agent/
   ├─ agent_loop.rs     streaming turn loop, tool dispatch, interrupt handling
   ├─ tools.rs          read · write · edit · bash · glob · grep + the sandbox
   ├─ config.rs         multi-endpoint / multi-model config, atomic writes
   └─ log.rs            append-only fan-out interaction log
```

The split is deliberate: **the renderer holds no authority.** It cannot read a file,
run a process, or open a socket except by asking one of the 27 commands, each of which
is a Rust function you can read. Every store in `src/store` is tested against an
in-memory fake backend, so the state machines are verified without a browser.

---

## Tech stack

| Layer | Choice |
|---|---|
| Shell | [Tauri 2.12](https://tauri.app) — Rust host, system WebView |
| UI | [SolidJS 1.9](https://www.solidjs.com), hand-written CSS with design tokens |
| Build | [Vite 8](https://vite.dev), [TypeScript 6](https://www.typescriptlang.org) |
| Editor | [Monaco 0.57](https://microsoft.github.io/monaco-editor/) + [Shiki 4](https://shiki.style) |
| PDF | [pdf.js 6](https://mozilla.github.io/pdf.js/) via `pdfjs-viewer-element` |
| Async | [`reqwest` 0.13](https://docs.rs/reqwest) (rustls, http2), `tokio`, `futures-util` |
| FS | [`notify` 8](https://docs.rs/notify), [`ignore` 0.4](https://docs.rs/ignore) |
| Agent search | [`grep-regex`](https://docs.rs/grep-regex), `grep-searcher`, `grep-matcher`, `globset` |
| Windows | `winreg` 0.55 — PATH from the registry, `.exe/.cmd/.bat` resolution |
| Tests | [Vitest 5](https://vitest.dev) + `cargo test` |

No UI framework, no component library, no state library, no CSS framework. Six runtime
dependencies, and the only one that would be hard to replace is pdf.js.

---

## Security & privacy

- **The renderer cannot make network requests.** The production CSP is
  `connect-src 'self' ipc: http://ipc.localhost` — there is no outbound origin.
- **No shell plugin, no fs plugin, no http plugin** in `capabilities/default.json`.
  The whole permission surface is `core:default`, eight window verbs (minimize,
  maximize, unmaximize, toggle, close, is-maximized, start-dragging) and two dialog
  verbs (open, message). Every filesystem and process operation is one of the app's
  own 27 commands.
- **The agent is jailed to the open folder.** Paths are canonicalized and checked
  against the conversation root; traversal outside it is refused before any I/O.
- **Your API key stays in Rust.** It is written to `llm.json` in the app config dir
  (plaintext on purpose — no OS keyring dependency, no unlock prompt, no silent
  breakage on Linux), and the renderer only ever sees an `sk-ab…9f2c` fingerprint.
- **Nothing leaves your machine but the model call.** Files, the directory index, the
  build artifacts and the interaction log are all local.

---

## Testing

```bash
npm test              # everything
npm run test:watch    # vitest, watch mode
npm run test:rust     # cargo test only
```

**223 TypeScript cases** and **103 Rust tests**. The suite is unusually paranoid about
the things that are hard to notice when they break:

- 500 watcher events produce 1 disk read, not 500.
- Expanding a parent does not move the reader's row.
- A failed build never back-fills the previous artifact.
- `turn.end` cannot close a turn that already ended — the frame tag is pinned.
- A stop does not wait on an endpoint that will never finish streaming.
- `../etc/passwd` is refused by the agent's `read`.
- A UTF-8 character split across two TCP writes still decodes.

The agent loop has an integration test that spins up a real `TcpListener` SSE server
in-process — no network, no key, no mocking of the streaming layer.

---

## Roadmap

Not built yet, in rough order of how much they'd improve the thing:

- [ ] Transcript import / export (`.jsonl`) — the menu entries are stubs today
- [ ] Real git integration for the Changes panel (right now it lists unsaved buffers)
- [ ] Bibliography management — `.bib` is syntax-highlighted, not managed
- [ ] macOS / Windows installers (`bundle.targets` is currently deb + AppImage only)
- [ ] Multi-root workspaces
- [ ] A real LaTeX completion source (label, ref, cite) rather than just highlighting

---

## Contributing

Issues and PRs are welcome. The bar is the same one the existing code holds itself to:
a behavior change wants a test, and a fix wants the test that would have caught it.
`npm test` must be green.

---

## License

BSD 2-Clause — see [LICENSE](LICENSE).
