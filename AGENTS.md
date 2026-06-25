# AGENTS.md — 插件开发 & 发布指南

本文件定义插件从开发到发布的完整流程。所有操作在主仓库（`main` 分支）完成。

## 仓库结构

根据插件复杂度选择一种目录布局：

### Layout 1: 裸文件（不推荐）

```
my-extension.ts
```

❌ **不推荐用于发布。** 没有 `package.json` 无法追踪版本，没有 README 无法提供文档，也不支持 `pi install` 独立安装。仅适合临时实验。

### Layout 2: 简单插件（推荐 — 单插件或小型集合）

```
pi-extensions/
├── README.md                  # 自动生成 — 插件列表（勿手动编辑 Extensions 部分）
├── package.json               # 仓库根配置
├── scripts/
│   ├── update-docs.ts         # 文档生成脚本
│   └── release.sh             # 发布辅助脚本
├── <plugin-name>/
│   ├── index.ts               # 插件源码
│   ├── package.json           # 插件元数据（含独立版本号）
│   └── README.md              # 插件详细文档
└── LICENSE
```

### Layout 3: 分组插件（推荐 — 复杂项目或多插件协作）

```
pi-extensions/
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

- `repository`: SSH 地址，用于 `git push`
- `installUrl`: HTTPS 地址，用于 `pi install`（公开只读）
- `pi.extensions`: 所有插件目录的相对路径列表（Layout 2 用目录名，Layout 3 用 `category/name` 路径）

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

- Provider 类插件还需声明 `@earendil-works/pi-ai` 为 peerDependency
- `pi.extensions` 指向入口文件（通常是 `./index.ts`）

## 发布流程

按以下步骤依次执行，不可跳过。

### Step 1: 完成编码

在功能分支或直接在 `main` 上修改插件源码。

- 新增/修改 `pi.registerProvider()`、`pi.registerCommand()`、`pi.registerTool()` 等
- 确保代码可被 TypeScript 编译（无类型错误）
- 同步更新插件目录下的 `README.md`

### Step 2: 冒烟测试

**目标**：确认插件不影响 pi 正常启动。

```bash
# 方式 1：直接加载测试
pi -e ./<plugin-path>/index.ts

# 方式 2：复制到扩展目录测试
cp <plugin-path>/index.ts ~/.pi/agent/extensions/<plugin-name>.ts
pi
```

检查项：
- [ ] pi 能正常启动，无崩溃或挂起
- [ ] `/model` 能看到新注册的 provider 和模型（如适用）
- [ ] `/login` 流程正常（如适用）
- [ ] 注册的命令/工具可正常调用（如适用）

### Step 3: 补全文档

#### 主仓库 README.md（自动生成）

```bash
npm run update-docs
```

脚本通过 TypeScript AST 解析各插件 `index.ts`，自动提取：
- `pi.registerProvider()` → provider id、名称、模型列表
- `pi.registerCommand()` → 命令名、描述
- `pi.registerTool()` → 工具名、描述
- `pi.registerShortcut()` → 快捷键、描述
- `pi.registerFlag()` → flag 名、描述

**不要手动编辑** README.md 中 `## Extensions` 到 `## Installation` 之间的内容。

#### 插件目录 README.md（手动维护）

每个插件的 `README.md` 需包含：

1. **一句话描述**（会被主仓库 README 引用）
2. **功能说明** — 插件做什么、解决什么问题
3. **适用范围** — 什么场景下使用
4. **设计说明** — 关键设计决策
5. **配置方法** — 环境变量、`/login` 步骤
6. **使用示例** — 模型选择、命令调用

插件 README 中的安装命令应使用 HTTPS 地址：

```bash
pi install https://github.com/USERNAME/REPO.git
```

### Step 4: 更新版本号并 git tag

```bash
# Layout 2: 直接用目录名
bash scripts/release.sh my-plugin patch

# Layout 3: 用 category/name 路径
bash scripts/release.sh category/my-plugin patch
```

脚本自动完成：
1. 更新插件 `package.json` 中的 `version`
2. 重新生成 README.md
3. 提交：`git commit -m "release: <plugin-name>@<version>"`
4. 创建 tag：`git tag <plugin-name>@<version>`
5. 推送：`git push && git push --tags`

### Step 5: 验证发布

- [ ] `git log --oneline -3` 确认提交记录
- [ ] `git tag -l` 确认 tag 存在
- [ ] 远端仓库可见新 tag
- [ ] `pi install <installUrl>` 能拉取到最新版本

## Tag 命名规范

```
<plugin-name>@<semver>
```

使用目录名（最后一个路径组件）作为插件名：

- `example-provider@1.0.0`
- `example-plugin@0.2.0`

## 创建新插件

### 在现有仓库中添加插件

1. 复制示例目录并重命名
2. 修改 `index.ts`、`package.json`、`README.md`
3. 在根 `package.json` 的 `pi.extensions` 中添加新插件路径
4. 运行 `npm run update-docs` 更新文档

### 从模板创建新仓库

1. 使用本模板创建新仓库（GitHub: Use this template）
2. 修改根 `package.json`：`name`、`repository`、`installUrl`
3. 删除示例插件目录
4. 创建自己的插件目录
5. 运行 `npm install` 安装开发依赖
6. 运行 `npm run update-docs` 生成 README

## 注意事项

- 插件版本号独立管理，互不影响
- `scripts/update-docs.ts` 依赖 `tsx` 和 `typescript`（devDependencies），运行前需 `npm install`
- `scripts/update-docs.ts` 支持递归扫描（最深 2 层），兼容 Layout 2 和 Layout 3
- 插件 README 中的安装命令使用 HTTPS 地址（`installUrl`），不使用 SSH
- 裸 `.ts` 文件（Layout 1）不支持版本管理和 `pi install`，不推荐用于发布
