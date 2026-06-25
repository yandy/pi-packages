# pi-vision-tools

Lets non-multimodal models analyze images by delegating to a configured vision model. A single `describe_image` tool + `/vision` command.

## Features

- **One tool** (`describe_image`) that sends an image + prompt to a vision-capable model and returns the text result to the calling model
- **Calling model controls cost/quality per call**: `compress` (on/off), `reasoning` (off through xhigh), and the prompt itself — no preconfiguration needed
- **Auto enable/disable** by calling model modality: if the current model already has image input, the tool disables itself; otherwise it's on
- **Footer indicator** (`👁 provider/model`) visible when the tool is active and a vision model is configured
- **No `/reload` required**: config changes take effect immediately

## How it works

```
calling model  →  describe_image  →  vision model  →  text back to calling model
 (no vision)       (image+prompt)      (sees image)
```

1. The calling model invokes `describe_image` with an image and a prompt
2. The tool decodes the image, optionally compresses it with sharp, then calls the configured vision model
3. The vision model's text answer is returned as the tool result

## Install

```bash
pi install npm:@yandy0725/pi-vision-tools
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@yandy0725/pi-vision-tools"]
}
```

## Configuration

### `/vision` command

| Command | What it does |
|---------|-------------|
| `/vision` or `/vision status` | Show current config: provider/model, enabled state, effective on/off, whether the calling model has vision |
| `/vision config provider <p>` | Set the vision model provider (e.g. `openai`, `anthropic`) |
| `/vision config model <m>` | Set the vision model ID (e.g. `gpt-4o`, `claude-sonnet-4-20250514`) |
| `/vision config default-reasoning <level>` | Set default reasoning depth: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `/vision on` | Force-enable the tool (even if the calling model has vision) |
| `/vision off` | Force-disable the tool |
| `/vision auto` | Auto mode: tool enabled only when the calling model lacks image input (default) |

Config is persisted to `~/.pi/agent/vision-tools.json` and takes effect immediately — no `/reload` needed.

### Optional: sharp

Install sharp for automatic image compression before sending:

```bash
npm install sharp
```

sharp is optional. Without it, images are sent as-is (no error). Compression downsamples the longest edge to ≤1568px, removes alpha, and converts to JPEG.

#### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_VISION_MAX_DIM` | `1568` | Longest-edge pixel limit (1–10000) |
| `PI_VISION_JPEG_QUALITY` | `85` | JPEG quality (1–100) |

Set `compress: false` on any call to skip compression for pixel-perfect needs (reading coordinates, inspecting tiny UI elements).

## Tool reference

```
describe_image(image_path: string, prompt: string, compress?: boolean, reasoning?: string)
```

| Parameter | Required | Default | Description |
|-----------|:--------:|---------|-------------|
| `image_path` | yes | — | File path, `data:` URL, or raw base64 (>100 chars) |
| `prompt` | yes | — | Instruction for the vision model |
| `compress` | no | `true` | Compress before sending; set `false` for pixel-perfect |
| `reasoning` | no | `off` | Reasoning effort: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |

### Example tool call

```json
{
  "image_path": "/home/user/screenshot.png",
  "prompt": "Describe what you see in this screenshot.",
  "compress": true,
  "reasoning": "high"
}
```

### Example prompts

| Goal | prompt |
|------|--------|
| Describe an image | `"Describe this image in detail."` |
| Read coordinates/position | `"What are the pixel coordinates of the submit button?"` |
| Extract text (OCR) | `"Extract all visible text from this image."` |
| Find UI bugs | `"Inspect this screenshot for layout, alignment, or text overflow issues."` |
| Explain a diagram | `"Explain this architecture diagram step by step."` |
| Analyze an error | `"What does this error message mean and how can it be fixed?"` |

### Reasoning levels

| Level | When to use |
|-------|-------------|
| `off` | Simple description, text extraction, basic Q&A |
| `minimal` | Quick glance, "what is this?" |
| `low` | Slightly more thought, moderate detail |
| `medium` | Detailed description, UI inspection |
| `high` | Complex analysis, architecture diagrams, code screenshots |
| `xhigh` | Deep reasoning, bug hunting, multi-step visual puzzles |

## Image formats

Supported: PNG, JPEG, GIF, WebP, BMP.

Input can be:
- A file path (`/path/to/image.png`, `./relative.png`, `~`-prefixed)
- A `data:` URL (`data:image/png;base64,...`)
- Raw base64 (string >100 characters, auto-detected)

## License

MIT
