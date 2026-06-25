# AGENTS.md — 插件开发 & 发布指南

本文件定义 pi 插件从开发到发布的完整规范。所有操作在主仓库（`main` 分支）完成。

---

## 仓库结构

根据插件数量选择一种布局：

### Layout 1: 裸文件（不推荐）

```
my-extension.ts
```

❌ 无 `package.json` 无法追踪版本，无 README 无法提供文档，不支持 `pi install`。仅适合临时实验。

### Layout 2: 简单插件

```
<repo>/
├── README.md              # 自动生成 — 插件列表
├── package.json           # 仓库根配置
├── scripts/
│   ├── update-docs.ts     # 文档生成脚本
│   └── release.sh         # 发布辅助脚本
├── <plugin-name>/
│   ├── index.ts           # 插件源码
│   ├── package.json       # 插件元数据（含独立版本号）
│   └── README.md          # 插件详细文档
└── LICENSE
```

### Layout 3: 分组插件

```
<repo>/
├── README.md
├── package.json
├── scripts/
│   ├── update-docs.ts
│   └── release.sh
├── <category>/
│   └── <plugin-name>/
│       ├── index.ts
│       ├── package.json
│       └── README.md
└── LICENSE
```

---

## 配置说明

### 根 `package.json`

```json
{
  "name": "my-extensions",
  "repository": "git@github.com:USERNAME/REPO.git",
  "installUrl": "https://github.com/USERNAME/REPO.git",
  "pi": {
    "extensions": [
      "plugin-a",
      "category/plugin-b"
    ]
  }
}
```

| 字段 | 说明 |
|------|------|
| `repository` | SSH 地址，用于 `git push` |
| `installUrl` | HTTPS 地址，用于 `pi install`（公开只读） |
| `pi.extensions` | 插件目录的相对路径列表 |

### 插件 `package.json`

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "pi": {
    "extensions": ["./index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  }
}
```

- Provider 类插件需额外声明 `@earendil-works/pi-ai` 为 peerDependency
- `pi.extensions` 指向入口文件（通常 `./index.ts`）

---

## 设计规范

### 命名规范

| 面向 | 风格 | 格式 | 示例 |
|------|------|------|------|
| **Tool**（agent 调用） | `snake_case` | `<prefix>_<verb>` | `gh_pr_create`, `db_query`, `remind_set` |
| **Command**（用户键入） | `kebab-case` | `/<prefix>-<verb>` | `/gh-pr-create`, `/db-query`, `/remind-set` |

- **prefix**：标识来源插件，适中用全称，过长可缩写
- **verb**：单一动词描述动作（`set`、`list`、`cancel`、`create`、`delete`）
- **例外**：非动词但语义自明的 getter 可保留（如 `alarm_now`、`gh_whoami`）

### Tool 设计原则

**1. 单一职责**

一个 tool 只做一件事，禁止用 `action` 枚举合并多种操作：

```typescript
// ❌ 反模式
pi.registerTool({
  name: "myplugin",
  parameters: Type.Object({
    action: Type.StringEnum(["create", "list", "delete"]),
  }),
  async execute(params) {
    switch (params.action) { /* ... */ }
  },
});

// ✅ 正例
pi.registerTool({ name: "myplugin_create", ... });
pi.registerTool({ name: "myplugin_list",   ... });
pi.registerTool({ name: "myplugin_delete", ... });
```

**2. 同类概念分离**

如果一个操作有两种语义不同的输入模式（如相对 vs 绝对），拆为两个 tool：

```typescript
// ✅ 相对模式
myplugin_schedule(delay_seconds=300)

// ✅ 绝对模式
myplugin_schedule_at(timestamp="2026-06-26T14:30:00Z")
```

**3. 参数严格校验**

Tool 面向 agent，应严格校验格式，不依赖宽松的运行时解析：

```typescript
// ✅ 用正则 / 类型约束在入口处校验
const PATTERN = /^\d{4}-\d{2}-\d{2}$/;
if (!PATTERN.test(params.date)) {
  return { content: [{ type: "text", text: "Error: expected YYYY-MM-DD" }] };
}
```

**4. 合并冗余参数**

同一概念不拆成多个参数。用单一字段 + 有区分度的值表达：

```typescript
// ❌ 冗余
retryCount: Type.Optional(Type.Number({ ... })),
noRetry:    Type.Optional(Type.Boolean({ ... })),

// ✅ 统一
retry: Type.Optional(Type.String({
  description: "Number as string, or 'none'. Default: '3'."
})),
```

**5. 跨平台**

不假设 Unix 环境。时间、路径等使用 Node.js 内置 API：

```typescript
// ✅
const now = new Date();
const home = os.homedir();

// ❌
// exec("date")
// process.env.HOME
```

### Command 设计原则

**1. 比 tool 宽松**

Command 面向人类，接受自然表达；tool 面向 agent，要求精确格式：

```bash
# Command（灵活）
/myplugin-schedule in 5m Call mom
/myplugin-schedule at 14:30 Meeting

# Tool（严格）
myplugin_schedule(delay_seconds=300, message="Call mom")
myplugin_schedule_at(timestamp="2026-06-26T14:30:00+08:00", message="Meeting")
```

**2. LLM fallback**

解析失败时将原始输入交给 agent 处理，而非报错退出：

```typescript
const parsed = tryParse(input);
if (!parsed) {
  pi.sendUserMessage(
    `User input: "${input}". Please use the appropriate tool to handle this.`
  );
  return;
}
```

### 消息呈现

**内容优先，元数据次要** — LLM 收到的 `content` 应直接是核心内容，不包装冗余前缀：

```typescript
pi.registerMessageRenderer("my-message-type", (message, _options, theme) => {
  let text =
    theme.fg("customMessageLabel", "HEADER") + "\n" +
    theme.fg("customMessageText", theme.bold(message.content));  // 主行

  // footer: dimmed metadata
  if (message.details?.id) {
    text += "\n" + theme.fg("dim", `#${message.details.id} @ ${message.details.time}`);
  }

  return new Text(text, 1, 0, (s) => theme.bg("customMessageBg", s));
});
```

### 插件 README 结构

每个插件的 `README.md` 必须包含：

1. **一句话描述**（会被根 README 引用）
2. **功能说明** — 插件做什么
3. **适用范围** — 使用场景
4. **设计说明** — 关键设计决策
5. **配置方法** — 环境变量、`/login` 步骤等
6. **使用示例** — 模型选择、命令/Tool 调用示例

Tool 和 Command 应分别列出并标注命名风格：

```markdown
## Tools (agent-facing, snake_case)

### `myplugin_create`
...

## Commands (user-facing, kebab-case)

### `/myplugin-create`
...
```

---

## 发布流程

以下步骤按顺序执行，不可跳过。

### Step 1: 完成编码

- 修改插件源码（`index.ts`）
- 确保 TypeScript 无类型错误
- 同步更新插件目录下的 `README.md`

### Step 2: 冒烟测试

确认插件不影响 pi 正常启动：

```bash
pi -e ./<plugin-path>/index.ts
```

检查项：
- [ ] pi 正常启动，无崩溃
- [ ] 注册的 Tool / Command 可正常调用
- [ ] Provider 类插件：`/model` 可见新模型，`/login` 流程正常

### Step 3: 补全文档

```bash
npm run update-docs
```

脚本通过 TypeScript AST 自动提取 `index.ts` 中的注册信息并更新根 `README.md`。
**不要手动编辑** `## Extensions` 到 `## Installation` 之间的内容。

### Step 4: 更新版本号并打 tag

```bash
bash scripts/release.sh <extension-path> <bump>
```

`<bump>` 可选：`patch` | `minor` | `major` | `x.y.z`

脚本自动执行：
1. 更新插件 `package.json` 中的 `version`
2. 重新生成根 `README.md`
3. `git commit -m "release: <name>@<version>"`
4. `git tag <name>@<version>`
5. `git push && git push --tags`

### Step 5: 验证发布

```bash
git log --oneline -3     # 确认提交
git tag -l               # 确认 tag
pi install <installUrl>  # 确认可安装
```

---

## Tag 命名规范

```
<plugin-directory-name>@<semver>
```

使用插件目录的最后一个路径组件作为名称：

- `my-plugin@1.0.0`
- `category/other-plugin@0.2.0`

---

## 创建新插件

### 在现有仓库中添加

1. 创建插件目录及 `index.ts`、`package.json`、`README.md`
2. 在根 `package.json` 的 `pi.extensions` 中追加路径
3. 运行 `npm run update-docs`

### 从零创建新仓库

1. 从模板创建仓库（GitHub: Use this template）
2. 修改根 `package.json`：`name`、`repository`、`installUrl`
3. 创建插件目录，编写源码
4. 运行 `npm install && npm run update-docs`

---

## 注意事项

- 插件版本号独立管理，互不影响
- `scripts/update-docs.ts` 依赖 `tsx` 和 `typescript`（devDependencies），运行前需 `npm install`
- 脚本支持递归扫描（最深 2 层），兼容 Layout 2 和 Layout 3
- 插件 README 中的安装命令使用 HTTPS 地址（`installUrl`），不使用 SSH
- 裸 `.ts` 文件（Layout 1）不支持版本管理和 `pi install`，不推荐用于发布
