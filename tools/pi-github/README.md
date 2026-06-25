# pi-github

Multi-platform Git forge automation — interact with GitHub, Gitea, and Forgejo APIs through pi, with configurable base URL and authorization for self-hosted instances. Supports **multiple instances** identified by name, so an agent can operate across different platforms and accounts simultaneously.

## Features

- **Multi-instance**: Configure multiple platform connections (e.g. personal GitHub + work Gitea) and switch between them per tool call
- **Multi-platform**: Supports GitHub (including Enterprise), Gitea, and Forgejo
- **Configurable base URL**: Use any self-hosted instance
- **Token-based auth**: Personal access tokens for all platforms
- **Full issue management**: Create, list, view, and comment on issues
- **PR management**: Create, list, and view pull requests
- **Repository info**: Get repository metadata and statistics
- **Custom TUI rendering**: Compact, color-coded display of tool invocations and results

## Setup

### Add an instance

```
/gh-login
```

Follow the prompts to configure:
1. **Platform type** — GitHub, Gitea, or Forgejo
2. **Base URL** — API endpoint (defaults provided for well-known instances)
3. **Access token** — Personal access token with appropriate scopes
4. **Instance name** — Label used as the `instance` value in tool calls (e.g. `github`, `work-gitea`)
5. **Set as default** — Whether to make this the default instance

Run `/gh-login` multiple times to add more instances.

### Switch default instance

```
/gh-switch
```

Select which instance to use by default when no `instance` parameter is specified in a tool call.

### Check configuration

```
/gh-status
```

Lists all configured instances with type, URL, and masked token.

### Token Scopes

| Platform | Required Scopes |
|----------|----------------|
| GitHub | `repo` (private repos) or `public_repo` (public only) |
| Gitea | Read/write access to issues and pull requests |
| Forgejo | Same as Gitea |

## Design

### Multi-instance architecture

Each platform connection is stored as a named instance in `~/.pi/agent/pi-github-config.json`:

```json
{
  "platforms": {
    "github": {
      "type": "github",
      "baseUrl": "https://api.github.com",
      "token": "ghp_xxx"
    },
    "work-gitea": {
      "type": "gitea",
      "baseUrl": "https://gitea.company.com/api/v1",
      "token": "xxx"
    }
  },
  "default": "github"
}
```

- One instance is the **default** — used when `instance` is omitted
- Any tool can override via `instance: "work-gitea"`
- Switch defaults with `/gh-switch`

### Platform detection

Auto-detected from the base URL:
- URLs containing `api.github.com` → GitHub
- All others using `/api/v1` conventions → Gitea/Forgejo

### API differences handled transparently

| Aspect | GitHub | Gitea / Forgejo |
|--------|--------|-----------------|
| Auth header | `Authorization: Bearer <token>` | `Authorization: token <token>` |
| Accept header | `application/vnd.github+json` | `application/json` |
| Pagination param | `per_page` | `limit` |

## Tools (agent-facing, snake_case)

All tools accept an optional `instance` parameter to target a specific platform. Omit to use the default instance.

### `gh_issue_create`

Create a new issue.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `instance` | | Platform instance name (uses default if omitted) |
| `repo` | ✓ | Repository in `owner/repo` format |
| `title` | ✓ | Issue title |
| `body` | | Issue body (Markdown) |
| `labels` | | Array of label names |

### `gh_issue_list`

List issues with optional filters.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `instance` | | Platform instance name |
| `repo` | ✓ | Repository in `owner/repo` format |
| `state` | | `open`, `closed`, or `all` (default: `open`) |
| `labels` | | Comma-separated label filter |
| `page` | | Page number (default: 1) |
| `perPage` | | Results per page (default: 30, max: 100) |

### `gh_issue_get`

Get detailed information about a specific issue.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `instance` | | Platform instance name |
| `repo` | ✓ | Repository in `owner/repo` format |
| `number` | ✓ | Issue number |

### `gh_issue_comment`

Add a comment to an existing issue.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `instance` | | Platform instance name |
| `repo` | ✓ | Repository in `owner/repo` format |
| `number` | ✓ | Issue number |
| `body` | ✓ | Comment body (Markdown) |

### `gh_pr_create`

Create a new pull request.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `instance` | | Platform instance name |
| `repo` | ✓ | Repository in `owner/repo` format |
| `title` | ✓ | PR title |
| `head` | ✓ | Source branch name |
| `base` | ✓ | Target branch name |
| `body` | | PR description (Markdown) |
| `draft` | | Create as draft (GitHub only) |

### `gh_pr_list`

List pull requests with optional filters.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `instance` | | Platform instance name |
| `repo` | ✓ | Repository in `owner/repo` format |
| `state` | | `open`, `closed`, or `all` (default: `open`) |
| `page` | | Page number (default: 1) |
| `perPage` | | Results per page (default: 30, max: 100) |

### `gh_pr_get`

Get detailed information about a specific pull request.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `instance` | | Platform instance name |
| `repo` | ✓ | Repository in `owner/repo` format |
| `number` | ✓ | PR number |

### `gh_repo_get`

Get repository information.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `instance` | | Platform instance name |
| `repo` | ✓ | Repository in `owner/repo` format |

## Commands (user-facing, kebab-case)

### `/gh-login`

Add or update a platform instance. Interactive wizard: platform type → base URL → token → instance ID → set as default.

### `/gh-default`

Set which instance is the default (used when `instance` is omitted in tool calls). Quick select from all configured instances.

### `/gh-forget`

Remove a configured instance. Confirmation required. If removing the default, the first remaining instance becomes the new default.

### `/gh-status`

Display all configured instances with type, URL, masked token, and default marker. Shows guidance for next commands.

## Usage Examples

After setup, the AI agent can use tools across multiple instances by specifying the `instance` parameter:

```
> Create an issue in my-org/backend titled "Fix login bug" using instance=work-gitea
```

```
> List open PRs in owner/repo on instance=github, then also check instance=work-gitea
```

When `instance` is omitted, the default (set via `/gh-default`) is used silently — verified by the `@<id>` label in tool rendering.

## Install

```bash
pi install https://github.com/Traveler0014/pi-extension-template.git
```

## License

MIT
