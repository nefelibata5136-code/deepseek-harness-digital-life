# Third-party code and licenses

No node_modules, Python environments, browser-use source, Chrome, Codex binaries
or full DSH vendor tree is distributed. Native dependencies are lockfile-pinned;
licenses/npm-dependencies.json records resolved license metadata. Dependencies
retain their MIT/Apache/BSD/other terms; root MIT does not relicense them.

DSH is MIT, copyright 2026 DeepSeek. The original license is retained in
licenses/deepseek-harness-MIT.txt. Optional multi-window patch is an upstream
derivative. Vendor inspection used commit 5badb15009ae1756c3afe0ae0cef1faafc290ccc;
installed dependencies are 0.2.0-rc.2. Those are different version facts.

Qwen transport originated in another local author-owned research tool; the public
copy removes machine/global credential lookup. API usage does not license
redistribution of user data/site content. Optional installed dependencies include
browser-use, MCP, Playwright, requests, Pillow, httpx, psutil and uvicorn.
Their package notices remain with installation. Before distributing any bundled
environment/desktop binary, inspect the actual resolved licenses and native components.

[Upstream LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/LICENSE)
