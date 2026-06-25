# example-plugin

Example tool and command extension for pi — demonstrates how to register custom tools and slash commands.

> **This is a template.** Replace the placeholder logic with your actual implementation.

## Features

- **Tool:** `example_tool` — an AI-callable tool (replace with your logic)
- **Command:** `/example` — a user-invokable slash command

## Usage

### Tool

The AI can call `example_tool` during conversations. No user action needed — the model decides when to use it based on the description.

### Command

```
/example
```

## Install

```bash
pi install https://github.com/Traveler0014/pi-extension-template.git
```

## Customization Checklist

- [ ] Replace tool `name` and `description`
- [ ] Define tool `parameters` schema (JSON Schema)
- [ ] Implement tool `execute()` logic
- [ ] Replace command `name` and `description`
- [ ] Implement command `execute()` logic
- [ ] Update this README

## License

MIT
