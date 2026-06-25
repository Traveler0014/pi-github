# example-provider

Example provider extension for pi — demonstrates the basic structure for creating a provider plugin.

> **This is a template.** Replace the placeholder values with your actual API details.

## Models

| Model | Context | Max Output | Image |
|-------|---------|------------|-------|
| `example-model` | 128K | 4K | ✗ |

## Setup

### Option A: `/login` command (recommended)

```
/login → "Use an API key" → example → paste your key
```

### Option B: Environment variable

```bash
export EXAMPLE_API_KEY="your-key-here"
```

## Usage

```bash
/model example/example-model
```

## Install

```bash
pi install https://github.com/Traveler0014/pi-extension-template.git
```

## Customization Checklist

- [ ] Replace `baseUrl` with your API endpoint
- [ ] Replace `apiKey` env var name (`$EXAMPLE_API_KEY`)
- [ ] Update `MODELS` array with your actual models
- [ ] Adjust `compat` settings for your API's behavior
- [ ] Update `cost` with real pricing
- [ ] Update this README

## License

MIT
