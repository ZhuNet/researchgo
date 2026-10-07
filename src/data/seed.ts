export const SEED: Record<string, string> = {
  '/README.md': `# researchgo

A local-first research workspace: infinite-scale file tree, in-app LaTeX/PDF
preview, and an agent sidecar that speaks JSONL over stdio.

## Layout

    apps/desktop      SolidJS renderer (this app)
    crates/omp-core   session + tool runtime
    crates/omp-wire   JSONL protocol shared with the renderer
    paper             LaTeX manuscript, compiled to paper/build/main.pdf

## Notes

The renderer never talks to the agent directly. \`omp-sidecar\` owns the SDK
session and emits newline-delimited JSON; the frontend translates each frame
into a UI event before it reaches the interaction panel.
`,

  '/.gitignore': `target/
node_modules/
paper/build/
*.aux
*.log
.DS_Store
.env
`,

  '/AGENTS.md': `# Agent contract

- Never edit files under \`paper/build/\`; it is generated.
- Prefer \`rg\` over \`find\`; prefer \`cargo check\` over \`cargo build\`.
- Keep tool calls under 20 per turn. Batch independent reads.
- LaTeX edits must keep the preamble self-contained: no \`\\usepackage\` added
  after \`\\begin{document}\`.
`,

  '/config/omp.json': `{
  "session": {
    "model": "claude-sonnet-4.6",
    "maxTurns": 48,
    "contextWindow": 200000
  },
  "tools": {
    "read": { "maxBytes": 262144 },
    "bash": { "allow": ["rg", "cargo", "latexmk", "git"] },
    "edit": { "formatOnSave": true }
  },
  "transport": {
    "kind": "jsonl",
    "frame": "ndjson",
    "flush": "per-event"
  }
}
`,

  '/crates/omp-wire/src/protocol.rs': `//! Wire protocol shared by the sidecar and the renderer.
//!
//! Frames are newline-delimited JSON. The renderer treats the stream as
//! append-only and never assumes ordering beyond what a single \`id\` implies.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Frame {
    SessionStart {
        session_id: String,
        model: String,
        cwd: String,
        tools: Vec<String>,
    },
    AssistantMessage {
        id: String,
        text: String,
    },
    AssistantDelta {
        id: String,
        text: String,
    },
    AssistantDone {
        id: String,
    },
    ToolStart {
        id: String,
        call_id: String,
        name: String,
        input: serde_json::Value,
    },
    ToolOutput {
        id: String,
        call_id: String,
        chunk: String,
    },
    ToolEnd {
        id: String,
        call_id: String,
        ok: bool,
        summary: String,
    },
    FilePatch {
        path: String,
        op: PatchOp,
        bytes: usize,
    },
    Usage {
        input: u64,
        output: u64,
        cache_read: u64,
    },
    TurnEnd {
        reason: TurnReason,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PatchOp {
    Create,
    Modify,
    Delete,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnReason {
    Stop,
    Aborted,
    Error,
}

impl Frame {
    /// Frames that may be reordered by the transport layer.
    pub fn is_ordered(&self) -> bool {
        !matches!(self, Frame::Usage { .. })
    }
}
`,

  '/crates/omp-sidecar/src/main.rs': `use std::io::{self, BufRead, Write};

use omp_core::session::{Session, SessionConfig};
use omp_wire::protocol::Frame;

#[tokio::main]
async fn main() -> io::Result<()> {
    let config = SessionConfig::from_file("config/omp.json").await?;
    let mut session = Session::spawn(config).await?;

    let stdin = io::stdin();
    let mut stdout = io::stdout();

    emit(&mut stdout, Frame::SessionStart {
        session_id: session.id().to_string(),
        model: session.model().to_string(),
        cwd: session.cwd().display().to_string(),
        tools: session.tool_names(),
    })?;

    let mut lines = stdin.lock().lines();
    while let Some(line) = lines.next().transpose()? {
        if line.trim().is_empty() {
            continue;
        }
        for frame in session.handle_line(&line).await {
            emit(&mut stdout, frame)?;
        }
    }

    session.shutdown().await;
    Ok(())
}

fn emit(out: &mut impl Write, frame: Frame) -> io::Result<()> {
    let mut buf = serde_json::to_vec(&frame)?;
    buf.push(b'\\n');
    out.write_all(&buf)?;
    out.flush()
}
`,

  '/crates/omp-core/src/session.rs': `use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::mpsc;
use omp_wire::protocol::Frame;

pub struct SessionConfig {
    pub model: String,
    pub max_turns: u32,
    pub context_window: u32,
    pub tool_allowlist: Vec<String>,
}

pub struct Session {
    id: SessionId,
    model: String,
    cwd: PathBuf,
    tools: Vec<Tool>,
    tx: mpsc::UnboundedSender<Frame>,
}

impl Session {
    pub async fn handle_line(&mut self, line: &str) -> Vec<Frame> {
        match line {
            "{\\"type\\":\\"prompt\\"}" => self.run_turn().await,
            _ => Vec::new(),
        }
    }

    async fn run_turn(&mut self) -> Vec<Frame> {
        let mut out = Vec::new();
        for tool in self.tools.iter().take(4) {
            let _ = tool;
        }
        out.push(Frame::TurnEnd { reason: omp_wire::protocol::TurnReason::Stop });
        out
    }
}

pub type SessionId = Arc<str>;
`,

  '/paper/main.tex': `\\documentclass[11pt,a4paper]{article}

\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath,amssymb,amsthm}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{microtype}
\\usepackage{hyperref}

\\hypersetup{colorlinks=true,linkcolor=black,citecolor=black}
\\setlength{\\parskip}{2pt}

\\title{Scaling Agent Sessions to Infinite Workspaces}
\\author{Research Group \\textsc{Omp}}
\\date{}

\\begin{document}
\\maketitle

\\begin{abstract}
We present a workspace architecture in which an agent session, its file
tree, and its rendered artifacts share a single surface. The design keeps a
strict separation between a rendering-only frontend and a sidecar that owns
all business logic, and we show that the resulting system sustains trees with
hundreds of thousands of nodes without measurable frame cost.
\\end{abstract}

\\input{sections/introduction}
\\input{sections/method}
\\input{sections/results}

\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}
`,

  '/paper/sections/introduction.tex': `\\section{Introduction}

Tool-using agents are usually constrained by the surface they can observe. A
flat file list, a paginated tree, or a transcript without inline artifacts all
force the model into a lossy summary of its own workspace. We argue that the
file tree is the primary context surface for research work, and that a session
which can address any node of that tree -- at any depth, without loading it
into a dialog -- is materially more capable.

\\paragraph{Contribution.} We describe \\emph{omp}: a split architecture in
which a Rust sidecar owns the SDK session and a SolidJS renderer owns nothing
but pixels. Communication is a newline-delimited JSON protocol, translated
once, at the boundary.
`,

  '/paper/sections/method.tex': `\\section{Method}

\\subsection{Normalized store}

The workspace is stored as a flat map from path to node, so that every
mutation touches $O(1)$ entries regardless of tree depth:

\\[
  \\mathcal{S} : \\mathrm{Path} \\to \\mathrm{Node},
  \\qquad
  \\mathrm{Node} = (\\mathrm{kind}, \\mathrm{name}, \\mathrm{children}, \\mathrm{meta}).
\\]

Rendering is derived, never persisted. A projection walks only expanded
directories and yields a flat row list, which is then windowed:

\\[
  \\mathrm{visible}(t, h, r) = \\Big\\{ i \\;\\big|\\;
  \\frac{t - r\\cdot h}{\\Delta} \\le i < \\frac{t + h}{\\Delta} + r \\Big\\}.
\\]

\\subsection{Boundary translation}

Raw frames arrive as JSON text. The renderer applies a total function
$\\tau$ from frames to UI events; anything $\\tau$ cannot classify is surfaced
as an error rather than dropped, so protocol drift is loud instead of silent.
`,

  '/paper/sections/results.tex': `\\section{Results}

We generated synthetic workspaces of increasing size and measured the time to
produce a stable frame after an expand operation.

\\begin{table}[h]
\\centering
\\begin{tabular}{lrrr}
\\toprule
Nodes & Tree build & First paint & Frame cost \\\\
\\midrule
1{,}000   & 0.9 ms  & 4.1 ms  & 0.2 ms \\\\
50{,}000  & 6.4 ms  & 5.0 ms  & 0.3 ms \\\\
500{,}000 & 71 ms   & 5.6 ms  & 0.4 ms \\\\
\\bottomrule
\\end{tabular}
\\caption{Expand latency is dominated by the first full projection, which is
paid once per session and then cached.}
\\end{table}

Frame cost is flat because the windowed row set never exceeds the viewport,
independent of workspace size.
`,

  '/paper/references.bib': `@article{agent2025,
  title   = {Tool Use in Long-Horizon Sessions},
  author  = {Omp, Research Group},
  journal = {arXiv preprint},
  year    = {2025}
}

@book{jsonl,
  title     = {Newline-Delimited JSON},
  author    = {Steele, Robert},
  publisher = {Self-published},
  year      = {2024}
}
`,

  '/data/results.csv': `nodes,tree_build_ms,first_paint_ms,frame_cost_ms
1000,0.9,4.1,0.2
50000,6.4,5.0,0.3
500000,71.0,5.6,0.4
`,

  '/scripts/build.sh': `#!/usr/bin/env bash
set -euo pipefail

echo "==> cargo check"
cargo check --workspace

echo "==> latexmk"
cd paper
latexmk -pdf -interaction=nonstopmode main.tex

echo "==> done: build/main.pdf"
`,

  '/.omp/session.json': `{
  "sessions": [
    {
      "id": "01JQZ8",
      "title": "Scale the file tree",
      "turns": 12,
      "updated": "2026-03-11T09:24:00Z"
    }
  ]
}
`,
};

export const SEED_DIRS = [
  '/.git',
  '/.omp',
  '/apps',
  '/config',
  '/crates',
  '/data',
  '/paper',
  '/paper/build',
  '/paper/sections',
  '/scripts',
  '/crates/omp-core',
  '/crates/omp-core/src',
  '/crates/omp-sidecar',
  '/crates/omp-sidecar/src',
  '/crates/omp-wire',
  '/crates/omp-wire/src',
  '/apps/desktop',
  '/apps/desktop/src',
];

export const GIT_STATUS: Record<string, 'modified' | 'added' | 'untracked'> = {
  '/crates/omp-wire/src/protocol.rs': 'modified',
  '/crates/omp-sidecar/src/main.rs': 'modified',
  '/paper/sections/results.tex': 'added',
  '/data/results.csv': 'untracked',
};

export const PDF_TARGET = '/paper/build/main.pdf';
