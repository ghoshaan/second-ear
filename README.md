# ATC Transcript Audit Tool

A client-side tool for comparing transcript snapshots and auditing edit history.

## Features

- **Compare**: View differences between snapshots (e.g., initial state vs. latest revision).
- **Audit**: Track approval status, labelers, and reviewer comments.
- **Export**: Generate print-friendly PDF reports of selected recordings with full history and diff highlights.
- **Private**: All processing happens client-side in your browser. No data is uploaded to any server.

## Getting Started

1. Open `public/index.html` in a modern web browser.
2. Upload one or more Labelbox NDJSON snapshots.
3. If multiple snapshots are provided, the tool will automatically align them and highlight changes.

## Usage

- **Search**: Use the browser's find (Cmd/Ctrl+F) for text search.
- **Select**: Use checkboxes to pick recordings for export.
- **History**: Click the parchment icon (📜) to expand version history for a recording.
- **Instructions**: Guidelines for audit procedures are available via the "Instructions" link in the header.

## Development

The tool is a standalone HTML application. No build step is required for the core functionality.

```bash
# Install dependencies (optional, for local serving)
npm install

# Open in browser
# (Open public/index.html directly or serve with a static server)
```

Legacy build scripts and static site generation logic have been removed in favor of the full client-side processing model.
