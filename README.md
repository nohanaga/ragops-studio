<p align="center">
  <img src="./public/icon.png" alt="RAGOps Studio — for Azure AI Search" width="240" height="240">
</p>

# RAGOps Studio — for Azure AI Search

**RAGOps, from query to quality.**

A web-based development tool for learning and experimenting with advanced features of Azure AI Search.

![RAGOps Studio — for Azure AI Search](https://img.shields.io/badge/Azure-AI%20Search-0078D4?style=flat-square&logo=microsoft-azure)
![React](https://img.shields.io/badge/React-19.2-61DAFB?style=flat-square&logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript)
![Vite](https://img.shields.io/badge/Vite-7.2-646CFF?style=flat-square&logo=vite)

> 📦 RAGOps Studio Series
>
> - RAGOps Studio — for Azure AI Search (this repo): A React/TypeScript workbench for observing, comparing, and improving search index quality (Series #1)
> - [RAGOps Studio — for Document Intelligence / Content Understanding](https://github.com/nohanaga/ragops-studio-for-di-cu): A workbench for refining the document parsing layer with Azure AI Document Intelligence and Content Understanding (Series #2)
>
> - 日本語版: [README.jp.md](README.jp.md) | [FEATURES.jp.md](FEATURES.jp.md) | [INTRODUCTION.jp.md](docs/INTRODUCTION.jp.md)

![](./docs/images/screenshot1_en.jpg)

> **📖 For a comprehensive introduction to RAGOps Studio, see [Introduction](docs/INTRODUCTION.md)**

## Features

- 🔍 **4 Search Modes**: Classic search, Semantic & Vector search, Agentic search (Knowledge Retrieval API), Text analysis
- 🛠️ **Builder Tools**: Create and manage indexes, knowledge sources, knowledge bases, synonym maps, and skillsets (visual pipeline builder)
- 🧩 **Skill Pipeline Builder**: Visual DAG editor for skillset authoring with built-in skill templates, enrichment tree preview, and debug runner
- 📝 **Custom Skill LiveEditor**: Browser-integrated Python IDE for Custom Skills with local execution (Pyodide/WASM), cloud deployment (Azure Container Apps), and Blob Storage sync
- 🧬 **Eval Dataset Generator**: Automatically generate AutoTuning-compatible JSONL evaluation datasets from index documents using Azure OpenAI, with multi-stage quality filters (round-trip consistency, semantic dedup, difficulty evolution, hard negative mining), and RAFT/HyDE dataset generation
- 📊 **Performance Testing**: QPS tester, search pipeline visualizer
- 🎯 **Search Parameter AutoTuning**: Automatically optimize search parameters using evaluation datasets
- 🧪 **Experiment Management**: Save query history, compare results, export/import
- 🎨 **Rich UI**: 6 themes, bilingual (EN/JP), 3-pane layout, resizable panels
- 🧭 **Feature Portal**: Interactive welcome screen with card-based feature directory, step-by-step guided walkthroughs with UI element highlighting, and companion mode for hands-on learning
- 💾 **Offline Support**: Data storage in browser using IndexedDB

## Setup

### Requirements
- Node.js 18 or later
- Azure AI Search service

### Installation

```bash
# Clone the repository
git clone https://github.com/nohanaga/ragops-studio.git
cd ragops-studio

# Install dependencies
npm install
```

### Start Development Server

```bash
npm run dev
```

Open `http://localhost:5173` in your browser.

### Build

```bash
npm run build
```

Build artifacts will be output to the `dist/` directory.

### Skill Runtime (Optional)

To use the **Custom Skill LiveEditor**'s remote execution and cloud deployment features, you need to set up the Skill Runtime — a FastAPI-based Python backend deployed on Azure Container Apps.

See [skill-runtime/README.md](skill-runtime/README.md) for setup and deployment instructions.

## Usage

1. **Connection Settings**: Configure your Azure AI Search endpoint and API key from the "Settings" in the header
2. **Select Mode**: Choose from Query / Semantic-Vector / Agentic / Analyze
3. **Create Query**: Enter search conditions using the form or JSON editor
4. **Execute**: Click "Run" button (or Enter)
5. **View Results**: Check results in the center pane, JSON in the right pane

For detailed feature documentation, see [FEATURES.md](FEATURES.md).

## Commands

```bash
# Development server
npm run dev

# Production build
npm run build

# Lint
npm run lint

# Test
npm run test

# Preview (after build)
npm run preview

# Generate synonym map
npm run gen:synonymmap
```

## Tech Stack

- **React 19.2** - UI framework
- **TypeScript 5.9** - Type-safe development
- **Vite 7.2** - Fast build tool
- **Bootstrap 5.3** - UI components
- **CodeMirror 6** - Code editor
- **ReactFlow (@xyflow/react)** - Flow chart visualization
- **dagre** - Automatic graph layout
- **Pyodide** - In-browser Python execution via WebAssembly
- **IndexedDB (idb)** - Client-side database

## Project Structure

```
ragops-studio/
├── src/
│   ├── components/     # React components
│   ├── hooks/          # Custom hooks
│   ├── lib/            # Core logic (API, DB, translations)
│   ├── types/          # TypeScript type definitions
│   ├── utils/          # Utility functions
│   └── App.tsx         # Main component
├── public/             # Static files
├── skill-runtime/     # Cloud Skill Runtime (FastAPI + Python)
├── scripts/            # Build scripts
└── package.json        # npm configuration
```

## Security & CORS notice

- This app is primarily a **local development/learning tool**. Connection settings (including API keys or bearer tokens) are handled by the browser.
- **Do not ship a public deployment that exposes Azure AI Search credentials to end users.** For production/public use, put credentials on a **server-side** component and call Azure AI Search via your own back-end/proxy.
- Azure AI Search CORS is limited. Microsoft documentation notes that, **for security reasons, only query APIs support CORS** (configured via index `corsOptions`).
- `npm run dev` includes a development proxy to avoid CORS during local development. `npm run preview` serves the production build and will make direct browser requests unless you provide a back-end/proxy.


## License

This project is licensed under the terms specified in the [LICENSE](LICENSE) file.


This is a personal project and is not an official Microsoft product. This project is community-driven and provided AS-IS without any warranties. The developers, including Microsoft, assume no responsibility for any issues arising from the use of this software, and no official support is provided.

## Related Links

- [Azure AI Search Documentation](https://learn.microsoft.com/azure/search/)
- [Azure AI Search REST API Reference](https://learn.microsoft.com/rest/api/searchservice/)
- [Introduction](docs/INTRODUCTION.md)
- [Detailed Feature Guide](FEATURES.md)
- [Skill Runtime (Custom Skill Backend)](skill-runtime/README.md)

---

**RAGOps, from query to quality.**
