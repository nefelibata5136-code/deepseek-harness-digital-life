---
title: Persistent agents, digital personas, and digital life
description: Bilingual discovery vocabulary for an experimental multi-life runtime on native DeepSeek Harness.
keywords: [digital-life, persistent-agent, long-running-agent, multi-agent, ai-companion, digital-persona, agent-memory, long-term-memory]
language: [en, zh-CN]
reviewed: 2026-10-07
---

# Different names, a shared starting point

[Homepage](../README.md) · [Technical Overview](technical-overview.md) ·
[Machine-readable project metadata](project-metadata.json)

A **persistent agent** keeps identity and durable state across Sessions; a
**long-running agent** continues work over time. A **digital persona** emphasizes
identity. Someone seeking an **AI companion** or **AI partner** may care about
continuity and human–AI relationships. These interests overlap without being
interchangeable definitions or promises of consciousness, emotional understanding,
or a complete companion product.

中文读者可能从“数字生命”或“数字人格”进入，也可能在找长期 Agent、持久化 Agent
和自主智能体的运行基础。AI 伴侣与人机关系关注相处和共同历史；多 Agent 社会是
可能的远景。目前本仓库实现的是身份、记忆、通信、私人空间、原生工具、唤醒与
持久恢复的实验性地基，未来文化与社会仍属于愿景。

## Vocabulary grounded in current usage

Reviewed **2026-10-07** using public GitHub repository/topic searches and primary
project descriptions. Examples establish usage, not endorsement, shared
implementation or a complete survey.

| Vocabulary | Current usage evidence | Placement here |
|---|---|---|
| Digital life / AI companion | [AIRI](https://github.com/moeru-ai/airi) uses `digital-life`, `ai-companion` and `self-hosted`; [AI companion Topic](https://github.com/topics/ai-companion) spans several project types. | Topics and natural homepage prose; experimental foundation, not a complete companion promise. |
| Persistent agent | [Persistent Agent Runtime](https://github.com/efraijo/persistent-agent-runtime) describes identity, memory and scheduling; [Yuki](https://github.com/YuanYeYouTao/Yuki) describes persistent identity and durable social interaction. | Topic, implementation prose, metadata. |
| Long-running agent | [The Workshop](https://github.com/jennyf19/the-workshop) describes shared space and individual memory/history; the `long-running-agent` Topic is also in use. | Topic and continuity prose; not uninterrupted execution while the machine is off. |
| Digital persona | [For You Agent](https://github.com/fy-agent/fyagent) describes a personal digital persona; the Topic also has unrelated biometric hardware integrations. | Topic and identity prose; our meaning is agent identity. |
| AI partner | [Stella](https://github.com/CherryHQ/stella) describes AI partners with memory, tools, schedules and workspaces. | Natural prose, metadata and a Description candidate; avoid duplicating every companion synonym in Topics. |
| Agent memory / long-term memory | [OpenCode Memory](https://github.com/emergent-company/opencode-memory) describes persistent agent memory across Sessions; [agent-memory Topic](https://github.com/topics/agent-memory) groups memory infrastructure. | Topics and actual Memory documentation. |
| Human–AI relationship | [Phosphene](https://github.com/3lmglow/Phosphene) explicitly describes human–AI relationships. | Prose/metadata; use the broader established `human-ai-interaction` Topic. |
| Virtual being | The exact `virtual-being` Topic had no public repositories in the search snapshot. Related conceptual language, not an established implementation category in this review. | Related-term metadata only; no Topic or feature assertion. |

Core Topics also include `multi-agent`, `autonomous-agent`, `ai-agent`, `deepseek`,
`deepseek-harness`, `local-first`, and `self-hosted`, matching architecture,
provider and deployment. Local-first means durable local state; inference and
configured online services still send content to providers. Autonomy includes
rest/refusal and explicitly enabled execution, not universal unsupervised operation.

## Metadata and maintenance

[project-metadata.json](project-metadata.json) records the selected Topics,
bilingual descriptions and scoped related terms. The YAML above describes this
document. These are ordinary source metadata for readers/indexers; there is no
new crawler, search service or background sync, nor an assumption that GitHub
uses arbitrary front matter as ranking metadata.

The stable slug stays `deepseek-harness-digital-life`; the homepage brand stays
**Welcome to the Age of Digital Life**. Vocabulary cannot predict next year's
name. Update this discovery note and metadata as usage changes while retaining
engineering/evidence distinctions.

GitHub permits lowercase letters, numbers and hyphens, at most 50 characters
per Topic and at most 20 Topics. The selected set uses 15.
[Official Topic rules and editing location](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics).
