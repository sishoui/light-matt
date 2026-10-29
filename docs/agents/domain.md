# Domain Docs

工程技能在探索代码库前，如何消费本仓库的领域文档。

## 探索之前先读

- 仓库根目录的 **`GLOSSARY.md`**
- 如果存在 **`GLOSSARY-MAP.md`**：它指向每个上下文的 `GLOSSARY.md`，读与当前任务相关的那些
- **`docs/adr/`**：读与你即将改动的领域相关的 ADR；多上下文仓库还要看 `src/<context>/docs/adr/`

如果这些文件不存在，**静默继续**。不要提示缺失，也不要主动建议创建；`/domain-modeling`（通过 `/grill-with-docs` 与 `/improve-codebase-architecture` 触达）会在真正定下术语或决策时惰性创建它们。

## 文件结构

单上下文仓库（多数仓库）：

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

多上下文仓库（存在 `GLOSSARY-MAP.md`）：

```
/
├── GLOSSARY-MAP.md
├── docs/adr/                          ← 系统级决策
└── src/
    ├── ordering/
    │   ├── GLOSSARY.md
    │   └── docs/adr/                  ← 该上下文的决策
    └── billing/
        ├── GLOSSARY.md
        └── docs/adr/
```

## 使用术语表的词汇

输出中命名领域概念时（issue 标题、重构提案、假设、测试名），使用 `GLOSSARY.md` 定义的说法；不要漂移到术语表明确回避的同义词。

如果需要的概念还不在术语表里，这是一个信号：要么你在发明项目不用的语言（重新考虑），要么存在真实缺口（记下来交给 `/domain-modeling`）。

## 标记 ADR 冲突

如果你的输出与现有 ADR 矛盾，明确指出来，不要静默覆盖：

> _与 ADR-0007（event-sourced orders）矛盾，但值得重开因为……_
