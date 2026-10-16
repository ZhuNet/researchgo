<div align="center">

<img src="docs/banner.svg" alt="ResearchGO" width="100%" />

# ResearchGO

**A focused desktop workspace for research, writing, and document review.**

</div>

## About

ResearchGO brings project files, source editing, document preview, workspace
search, and AI-assisted workflows into one desktop application. It is designed
for researchers and technical writers who want to work locally without moving
between multiple tools.

## Highlights

- Project explorer with file operations, search, and live filesystem updates
- Source editing for LaTeX, Markdown, code, and common research formats
- Integrated PDF preview and LaTeX build workflow
- Configurable AI models with workspace-aware assistance
- Local-first project data and build artifacts
- Light and dark appearance

## Requirements

- A supported Windows, macOS, or Linux desktop environment
- XeLaTeX available on `PATH` when compiling LaTeX projects
- An OpenAI-compatible model endpoint for optional AI features

## Privacy

Project files and generated documents remain on the local machine. Content is
sent to a configured model provider only when the user invokes an AI feature.
Users are responsible for reviewing the privacy and data-retention terms of
their selected provider.

## Internal development

```bash
npm install
npm run tauri:dev
npm test
npm run tauri:build
```

## Licensing

ResearchGO is proprietary commercial software and is not open source. Access to
this repository does not grant permission to copy, modify, redistribute, or use
the software except under an authorized written agreement. See the
[ResearchGO Proprietary Software License](LICENSE).

Third-party components remain subject to their respective licenses. Required
attributions are listed in
[Third-Party Notices](THIRD-PARTY-NOTICES.md).

Copyright © 2026 zhuhongjing. All rights reserved.
