# Leboncoin MCP Server

Low-resource MCP server for Leboncoin. Search uses the public SSR search page:

- `GET https://www.leboncoin.fr/recherche?...`, parsing `__NEXT_DATA__`.
- `GET https://api.leboncoin.fr/finder/classified/{id}` for listing details.

Leboncoin currently protects `/finder/search` with DataDome for raw HTTP. The server keeps that API path implemented for endpoint checks, but search tools use the normal search page directly.

If `LEBONCOIN_USER_AGENT` is unset or empty, the server sends a browser-like default user agent.

## Setup

```bash
npm install
npm run build
```

Optional environment variables:

```bash
LEBONCOIN_PROXY_URL=http://user:password@host:port
LEBONCOIN_COOKIE="datadome=..."
LEBONCOIN_USER_AGENT="Mozilla/5.0 ..."
MCP_OAUTH_ENABLED=true
PUBLIC_BASE_URL=https://lbc-mcp.duckdns.org
OAUTH_ISSUER=https://lbc-mcp.duckdns.org
```

## Claude Desktop config

```json
{
  "mcpServers": {
    "leboncoin": {
      "command": "node",
      "args": ["C:\\Users\\Narenku\\Documents\\00000000000_peip_2_2025-2026\\MMD\\video\\leboncoin-mcp\\dist\\index.js"],
      "env": {
        "LEBONCOIN_PROXY_URL": "http://user:password@host:port"
      }
    }
  }
}
```

## Docker

Build and run the MCP server as an HTTP service:

```bash
docker compose up --build
```

Health check:

```bash
curl http://localhost:3000/health
```

The container exposes:

- `http://localhost:3000/mcp` for MCP Streamable HTTP clients.
- `http://localhost:3000/sse` for older SSE MCP clients, including n8n's MCP Client Tool.
- `http://localhost:3000/messages` as the SSE message POST endpoint used automatically by MCP clients.

Use a proxy by creating a local `.env` next to `docker-compose.yml`:

```env
LEBONCOIN_PROXY_URL=http://user:password@host:port
LEBONCOIN_COOKIE=datadome=optional_cookie
```

## Codex

Codex-style local MCP clients normally use stdio. Point the client at the built script:

```json
{
  "mcpServers": {
    "leboncoin": {
      "command": "node",
      "args": [
        "C:\\Users\\Narenku\\Documents\\00000000000_peip_2_2025-2026\\MMD\\video\\leboncoin-mcp\\dist\\index.js"
      ],
      "env": {
        "LEBONCOIN_PROXY_URL": "http://user:password@host:port"
      }
    }
  }
}
```

If your MCP client supports HTTP directly, use:

```text
http://localhost:3000/mcp
```

If the MCP client runs inside another Docker container, use the Compose service name:

```text
http://leboncoin-mcp:3000/mcp
```

## n8n

n8n has two relevant MCP nodes:

- `MCP Client` can use an MCP endpoint URL. Use `http://leboncoin-mcp:3000/mcp` when n8n is in the same Compose network, or `http://host.docker.internal:3000/mcp` when n8n runs in Docker Desktop separately.
- `MCP Client Tool` for AI Agents asks for an SSE endpoint. Use `http://leboncoin-mcp:3000/sse` or `http://host.docker.internal:3000/sse`.

Authentication can stay `None` unless you put this service behind a reverse proxy.

## ChatGPT Apps OAuth

For a ChatGPT workspace app, do not protect the reverse proxy with a hardcoded Bearer token. Enable the built-in OAuth flow instead:

```env
MCP_OAUTH_ENABLED=true
PUBLIC_BASE_URL=https://lbc-mcp.duckdns.org
OAUTH_ISSUER=https://lbc-mcp.duckdns.org
```

The server then exposes:

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server`
- `/authorize`
- `/token`

Unauthenticated MCP requests return a `WWW-Authenticate` challenge pointing ChatGPT to the protected resource metadata. ChatGPT completes the authorization-code + PKCE flow, receives a Bearer access token, and sends that token on `/mcp`, `/sse`, and `/messages`.

OAuth is only enforced for requests whose `Host` or `X-Forwarded-Host` matches `PUBLIC_BASE_URL`. This lets public ChatGPT traffic through `https://lbc-mcp.duckdns.org` require OAuth while LAN/Docker calls such as `http://192.168.1.18:3000/sse` or `http://leboncoin-mcp:3000/sse` remain usable without OAuth.

## Tools

- `check_endpoints`: probes the important endpoints and shows payload templates.
- `search_listings`: searches listings with filters.
- `batch_search_listings`: runs up to 20 searches in one MCP call, in parallel, then deduplicates listings by ID.
- `get_listing_details`: gets full details from a listing URL or ID.
- `get_listing_details_batch`: gets full details for up to 50 listing URLs or IDs in one MCP call.
- `analyze_market_price`: compares a target price/listing with similar results.
- `search_multi_region`: runs searches across multiple departments/zipcodes.
- `watch_new_listings`: stores/checks watch definitions and returns newly seen ads.

For n8n agents, prefer the batch tools when checking product variants:

```json
{
  "searches": [
    { "query": "samsung s24", "sortBy": "price", "sortOrder": "asc", "minPrice": 150, "limit": 30 },
    { "query": "galaxy s24", "sortBy": "price", "sortOrder": "asc", "minPrice": 150, "limit": 30 },
    { "query": "samsung s25", "sortBy": "price", "sortOrder": "asc", "minPrice": 200, "limit": 30 }
  ],
  "limitPerSearch": 30,
  "maxResults": 100
}
```

`limitPerSearch` controls how many results each query variant fetches, using pagination when it is above one Leboncoin page. `maxResults` only caps the final merged/deduplicated output. For example, 9 very similar queries with `limitPerSearch: 35` may return fewer than 300 unique listings after deduplication; use `limitPerSearch: 100` with `maxResults: 300` when you want the batch to fill 300 results.

Then send the selected listing IDs to `get_listing_details_batch`:

```json
{
  "listings": ["3194392810", "3182346665", "3145491157"]
}
```
