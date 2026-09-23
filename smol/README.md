# SMOL Coder Plus 🚀

**SMOL Coder Plus** is an enhanced version of the original SMOL Coder, designed for more robust and capable AI agentic workflows. It takes the core principles of SMOL Coder and injects production-ready features to handle real-world complexity.

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
To install the global `smolcoder` command with the Plus enhancements:

```bash
# Navigate to the smol directory
cd smol

# Install globally
npm install -g .
```

### Configuration
Ensure you have your Brave API key set up in a `.env` file in your project root:

```env
BRAVE_API_KEY=your_api_key_here
```

## 🏗️ Architecture
- **Core Agent**: Enhanced with better planning and tool-use logic.
- **Web Search Tool**: A dedicated module for interacting with Brave Search.
- **Sandbox**: Secure execution environment for shell and file operations.
- **TUI/Web UI**: Sleek interfaces for monitoring agent progress.

---
*Built with ❤️ to make AI agents more capable, reliable, and ready for real-world tasks.*
