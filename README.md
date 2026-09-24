# SMOL Coder Plus 🚀

**SMOL Coder Plus** is an enhanced fork of the original [SMOL Coder](https://github.com/leonvanzyl/smolcoder) (MIT License, © Leon van Zyl), designed for more robust and capable AI agentic workflows. It takes the core principles of SMOL Coder and injects production-ready features to handle real-world complexity.

> This project is a fork of [leonvanzyl/smolcoder](https://github.com/leonvanzyl/smolcoder). The original copyright notice and MIT license are preserved in [`LICENSE`](./LICENSE).

## ✨ Key Enhancements

### 🌐 Integrated Web Search (Brave API)
The agent is no longer confined to its internal knowledge. 
- **Brave Search Integration**: Seamlessly browse the live web to get up-to-date information.
- **Smart Parsing**: Automatically extracts and formats web results for easier agent comprehension.
- **Safety & Limits**: Includes automatic output truncation and formatting to keep the context window clean.

### 🛠️ Robust Environment Handling
We've improved how the agent interacts with your system environment.
- **Recursive `.env` Loading**: The tool now intelligently searches for `.env` files in the current and parent directories. 
- **Why it matters**: You can run the agent from any subdirectory within your project, and it will still correctly find your API keys and configuration settings at the root.

### 🧪 Production-Ready Testing
Reliability is at the core of SMOL Coder Plus.
- **End-to-End Integration Tests**: We've added tests that simulate the full agent-to-tool-to-API path (using mocked network responses), ensuring that new features don't break existing ones.
- **Regression Test Suite**: Includes a dedicated `regtest.js` script. Run it to verify that core functionalities remain intact as you continue to build.

## 🚀 Getting Started

### Installation
Install the package globally from npm:

```bash
npm install -g smolcoder-plus
```

This adds **two commands** that do the same thing — `smolcoder-plus` and the
short alias `smolp`:

```bash
cd my-project
smolp            # or: smolcoder-plus
```

(Alternative: install from a local checkout with `npm install -g .` from
the project root.)

For development (keeps the commands linked to your working tree, so edits
take effect after a rebuild):

```bash
npm install
npm run build
npm link          # adds the `smolp` and `smolcoder-plus` commands
```

Unlink later with `npm unlink -g smolcoder-plus` (or `npm rm -g smolcoder-plus`).

### 🌐 Internet Search — Setup & Usage Guide

The agent ships with a `web_search` tool (Brave Search API) that it calls
automatically whenever it needs up-to-date information from the live web —
you don't need to invoke it manually. Just ask, e.g. *"What's the latest
stable version of TypeScript?"* and the agent will search and cite sources.

**1. Get a free API key**

1. Create a free account at [brave.com/search/api](https://brave.com/search/api/).
2. In the dashboard, create an API key. The free plan includes 1 query/second
   and 2,000 queries/month — plenty for agent use.

**2. Add the key to a `.env` file**

Put a `.env` file in your **project root**:

```env
BRAVE_API_KEY=your_api_key_here
```

- The loader walks **up from the current directory** to find `.env`, so the
  agent works from any subdirectory of the project.
- A real exported environment variable always wins over `.env` values:
  `export BRAVE_API_KEY=...` is a valid alternative (useful for CI).
- Keep the key secret — never commit `.env` (add it to `.gitignore`).

**3. Verify it works**

Run the agent in your project and ask something that requires live data.
If the key is missing, the tool returns `Error: Missing BRAVE_API_KEY
environment variable.` — that's your cue to set it up.

**Notes**

- Results are capped at 8 per call (default 5) and truncated to ~3,000 chars
  to keep the context window clean.
- No key? Everything else (file tools, shell, planning, TUI/Web UI) works
  normally — only `web_search` is unavailable.

### 🖥️ Web UI — Browser Interface

Prefer a browser over the terminal? Run:

```bash
smolp --web            # or: smolcoder-plus --web
```

- Serves the UI at **http://127.0.0.1:7433** (default port — pass a number to
  override: `smolp --web 8080`).
- Shows a **sidebar of your workspaces and sessions**, plus an embedded
  browser and terminal panel so you can watch the agent work.
- Run it from a project directory to start a session there immediately, or
  from anywhere (e.g. your home directory) to pick a workspace in the sidebar.
- A second `smolp --web` from another folder won't start a new server — it
  adds that folder to the already-running UI and prints its URL.
- Port already taken? It tells you the next one to try: `smolp --web 7434`.
- **Ctrl+C** stops the server.

## 🏗️ Architecture
- **Core Agent**: Enhanced with better planning and tool-use logic.
- **Web Search Tool**: A dedicated module for interacting with Brave Search.
- **Sandbox**: Secure execution environment for shell and file operations.
- **TUI/Web UI**: Sleek interfaces for monitoring agent progress.

---
*Built with ❤️ to make AI agents more capable, reliable, and ready for real-world tasks.*
