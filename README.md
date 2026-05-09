# pi-web-research-tools

Pi package with 3 installable research tools:
- `google_search`
- `perplexity_search`
- `deepwiki`

## Install

From GitHub:

```bash
pi install git:github.com/jfanals/pi-web-research-tools
```

Or pin a tag:

```bash
pi install git:github.com/jfanals/pi-web-research-tools@v0.1.0
```

## Environment variables

Add the keys you want to use to your shell profile:

```bash
export GOOGLE_API_KEY=your_google_ai_studio_key
export PERPLEXITY_API_KEY=your_perplexity_key
```

Optional:

```bash
export DEEPWIKI_MCP_URL=https://mcp.deepwiki.com/mcp
```

## Tools

### `google_search`
Google Search grounding through Gemini.

Parameters:
- `query` string
- `model` optional: `flash` or `pro`

### `perplexity_search`
Perplexity web research with cited answers.

Parameters:
- `query` string
- `model` optional: `sonar`, `sonar-pro`, `sonar-reasoning-pro`, `sonar-deep-research`

### `deepwiki`
Query public GitHub repositories through DeepWiki.

Parameters:
- `action`: `ask`, `structure`, `read`
- `repo`: `owner/repo`
- `question`: required for `ask`

## Publish

1. Create the GitHub repo `jfanals/pi-web-research-tools`
2. Push this package
3. Optionally create a release tag like `v0.1.0`

```bash
git init
git add .
git commit -m "Initial pi web research tools package"
git branch -M main
git remote add origin git@github.com:jfanals/pi-web-research-tools.git
git push -u origin main
git tag v0.1.0
git push origin v0.1.0
```

## Notes

- This package uses current `@earendil-works/*` import paths.
- It is packaged as a Pi package via the `pi` key in `package.json`.
- `deepwiki` talks to the public DeepWiki MCP endpoint over JSON-RPC.
