# Leboncoin MCP Server

Low-resource Model Context Protocol (MCP) server for searching and retrieving listings from Leboncoin with anti-bot fallback strategies.

## Resolution Pipeline

```text
Direct SSR (__NEXT_DATA__) -> Jina Reader Fallback -> Obscura Headless Fallback
```

The server attempts direct server-side rendered (SSR) JSON parsing first, automatically falling back to rendered Markdown/headless retrieval when anti-bot challenges are encountered.

## Features

- **Multi-Source Search**: Structured querying with price, category, and sorting filters.
- **Batch Processing**: Parallel multi-query execution with deduplication (`batch_search_listings`).
- **Resilient Listing Extraction**: Full ad details extraction using API, JSON-LD, or rendered page fallbacks.
- **Multi-Transport MCP**: Supports stdio, Streamable HTTP (`/mcp`), and SSE (`/sse`).
- **OAuth 2.0 PKCE Support**: Built-in authorization server for secure LLM/ChatGPT integration.

## Available Tools

- `search_listings`: Queries listings with filters.
- `batch_search_listings`: Runs up to 20 parallel search queries with automatic deduplication.
- `get_listing_details`: Retrieves full metadata and attributes for a listing.
- `get_listing_details_batch`: Batch listing metadata retrieval.
- `analyze_market_price`: Aggregates price statistics for market estimation.
- `search_multi_region`: Executes searches across multiple regional filters.
- `watch_new_listings`: State tracker reporting newly posted listings.
- `check_config`: Reports current proxy, anti-bot, and fallback subsystem diagnostics.
- `check_endpoints`: Probes endpoint health and response payloads.

## Setup & Running

### Build

```bash
git clone https://github.com/NarenkuII/Leboncoin_mcp.git
cd Leboncoin_mcp
npm install
npm run build
```

### Docker Deployment

```bash
docker compose up --build -d
```

Endpoints exposed:
- `http://localhost:3000/mcp` (Streamable HTTP)
- `http://localhost:3000/sse` (Server-Sent Events)
- `http://localhost:3000/health` (Health Check)

### MCP Client Configuration (e.g. Claude Desktop / Codex)

```json
{
  "mcpServers": {
    "leboncoin": {
      "command": "node",
      "args": ["/path/to/Leboncoin_mcp/dist/index.js"],
      "env": {
        "LEBONCOIN_PROXY_URL": "http://user:password@proxy-host:port"
      }
    }
  }
}
```

## Environment Configuration

Optional environment variables:

```bash
LEBONCOIN_PROXY_URL=http://user:password@host:port
LEBONCOIN_PROXY_ENABLED=true
LEBONCOIN_COOKIE_ENABLED=true
LEBONCOIN_COOKIE="datadome=..."
LEBONCOIN_USER_AGENT="Mozilla/5.0 ..."
JINA_READER_BASE=https://r.jina.ai/http://
JINA_PROXY_ENABLED=false
OBSCURA_BIN=obscura
MCP_OAUTH_ENABLED=false
PUBLIC_BASE_URL=https://your-mcp-domain.example.com
OAUTH_ISSUER=https://your-mcp-domain.example.com
```

## OAuth 2.0 for ChatGPT Apps

When deploying behind a public reverse proxy for ChatGPT Actions or Workspace integration:

```env
MCP_OAUTH_ENABLED=true
PUBLIC_BASE_URL=https://your-mcp-domain.example.com
OAUTH_ISSUER=https://your-mcp-domain.example.com
```

The server exposes standard discovery endpoints:
- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server`
- `/authorize`
- `/token`
