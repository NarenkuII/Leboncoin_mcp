import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import nodeHttp, { type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";

type Listing = {
  list_id: number | string;
  subject?: string;
  body?: string;
  category_id?: string;
  category_name?: string;
  url?: string;
  price?: number[];
  price_cents?: number;
  images?: { thumb_url?: string; urls?: string[]; nb_images?: number };
  attributes?: Array<{ key: string; key_label?: string; value?: string; value_label?: string }>;
  location?: {
    city?: string;
    zipcode?: string;
    department_id?: string;
    department_name?: string;
    region_name?: string;
    city_label?: string;
  };
  owner?: { type?: string; name?: string; store_id?: string; user_id?: string };
  first_publication_date?: string;
  has_phone?: boolean;
};

type SearchArgs = {
  query: string;
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  departments?: string[];
  zipcodes?: string[];
  regions?: string[];
  ownerType?: "all" | "private" | "pro";
  sortBy?: "time" | "price" | "relevance";
  sortOrder?: "asc" | "desc";
  limit?: number;
  offset?: number;
};

type NormalizedListing = ReturnType<typeof normalizeListing>;

const API_BASE = "https://api.leboncoin.fr";
const WEB_BASE = "https://www.leboncoin.fr";
const PAGE_SIZE = 35;
const DATA_DIR = path.join(process.cwd(), ".data");
const WATCHES_FILE = path.join(DATA_DIR, "watches.json");
const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const oauthIssuer = (process.env.OAUTH_ISSUER ?? publicBaseUrl).replace(/\/$/, "");
const oauthEnabled = process.env.MCP_OAUTH_ENABLED === "true";
const oauthTokenTtlSeconds = Number(process.env.OAUTH_TOKEN_TTL_SECONDS ?? 3600);
const oauthScopes = ["leboncoin:read"];
const publicHost = new URL(publicBaseUrl).host.toLowerCase();

const proxyUrl = process.env.LEBONCOIN_PROXY_URL;
const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

const userAgent =
  process.env.LEBONCOIN_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const categoryIds: Record<string, string> = {
  all: "",
  voitures: "2",
  cars: "2",
  auto: "2",
  motos: "3",
  motorcycles: "3",
  immobilier: "9",
  "real-estate-sales": "9",
  locations: "10",
  rentals: "10",
  informatique: "15",
  ordinateurs: "15",
  computers: "15",
  telephones: "16",
  smartphones: "16",
  mobilier: "19",
  meubles: "19",
  furniture: "19",
  emploi: "33",
  jobs: "33",
  consoles: "43",
  jeuxvideo: "43",
  "video-games": "43"
};

function headers(accept = "application/json, text/plain, */*") {
  const h: Record<string, string> = {
    "user-agent": userAgent,
    accept,
    "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
    origin: WEB_BASE,
    referer: `${WEB_BASE}/recherche`
  };
  if (process.env.LEBONCOIN_COOKIE) h.cookie = process.env.LEBONCOIN_COOKIE;
  return h;
}

async function http(url: string, init: RequestInit = {}) {
  const mergedHeaders = { ...headers(), ...(init.headers as Record<string, string> | undefined) };
  for (const [key, value] of Object.entries(mergedHeaders)) {
    if (value === "") delete mergedHeaders[key];
  }
  return undiciFetch(url, {
    ...init,
    dispatcher,
    headers: mergedHeaders
  } as Parameters<typeof undiciFetch>[1]);
}

function categoryId(category?: string) {
  if (!category) return undefined;
  const key = category.toLowerCase().trim();
  return /^\d+$/.test(key) ? key : categoryIds[key];
}

function buildSearchPayload(args: SearchArgs) {
  const filters: Record<string, unknown> = {
    enums: { ad_type: ["offer"] },
    keywords: { text: args.query, type: "all" }
  };
  const cat = categoryId(args.category);
  if (cat) filters.category = { id: cat };
  const location: Record<string, string[]> = {};
  if (args.departments?.length) location.departments = args.departments;
  if (args.zipcodes?.length) location.zipcodes = args.zipcodes;
  if (args.regions?.length) location.regions = args.regions;
  if (Object.keys(location).length) filters.location = location;
  const ranges: Record<string, { min?: number; max?: number }> = {};
  if (args.minPrice !== undefined || args.maxPrice !== undefined) {
    ranges.price = { min: args.minPrice, max: args.maxPrice };
  }
  if (Object.keys(ranges).length) filters.ranges = ranges;
  return {
    limit: Math.min(args.limit ?? 10, PAGE_SIZE),
    limit_allday: 0,
    offset: args.offset ?? 0,
    sort_by: args.sortBy ?? "time",
    sort_order: args.sortOrder ?? "desc",
    owner_type: args.ownerType ?? "all",
    filters
  };
}

function buildSearchUrl(args: SearchArgs) {
  const url = new URL("/recherche", WEB_BASE);
  url.searchParams.set("text", args.query);
  const cat = categoryId(args.category);
  if (cat) url.searchParams.set("category", cat);
  if (args.minPrice !== undefined || args.maxPrice !== undefined) {
    url.searchParams.set("price", `${args.minPrice ?? ""}-${args.maxPrice ?? ""}`);
  }
  if (args.ownerType && args.ownerType !== "all") url.searchParams.set("owner_type", args.ownerType);
  if (args.sortBy) url.searchParams.set("sort", args.sortBy);
  if (args.offset && args.offset >= PAGE_SIZE) url.searchParams.set("page", String(Math.floor(args.offset / PAGE_SIZE) + 1));
  for (const dep of args.departments ?? []) url.searchParams.append("locations", `d_${dep}`);
  for (const zipcode of args.zipcodes ?? []) url.searchParams.append("locations", `z_${zipcode}`);
  return url;
}

function parseNextData(html: string) {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error("Could not find __NEXT_DATA__ in Leboncoin HTML response.");
  return JSON.parse(match[1]);
}

function normalizeListing(ad: Listing) {
  const price = ad.price?.[0] ?? (ad.price_cents ? ad.price_cents / 100 : undefined);
  return {
    id: String(ad.list_id),
    title: ad.subject ?? "",
    price,
    url: ad.url ?? `${WEB_BASE}/ad/${ad.category_name ?? "annonce"}/${ad.list_id}`,
    description: ad.body ?? "",
    category: ad.category_name ?? ad.category_id ?? "",
    publishedAt: ad.first_publication_date,
    location: ad.location
      ? [ad.location.city_label ?? ad.location.city, ad.location.department_name].filter(Boolean).join(", ")
      : "",
    owner: ad.owner ? { name: ad.owner.name, type: ad.owner.type } : undefined,
    hasPhone: ad.has_phone,
    image: ad.images?.thumb_url ?? ad.images?.urls?.[0],
    attributes: Object.fromEntries(
      (ad.attributes ?? [])
        .filter((a) => a.key && (a.value_label || a.value))
        .map((a) => [a.key_label ?? a.key, a.value_label ?? a.value])
    )
  };
}

async function searchViaApi(args: SearchArgs) {
  const res = await http(`${API_BASE}/finder/search`, {
    method: "POST",
    headers: { "content-type": "application/json", referer: buildSearchUrl(args).toString() },
    body: JSON.stringify(buildSearchPayload(args))
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`API search failed ${res.status}: ${text.slice(0, 220)}`);
  const json = JSON.parse(text);
  return {
    source: "api",
    total: json.total ?? json.total_all,
    ads: [...(json.ads ?? []), ...(json.ads_alu ?? [])].slice(0, args.limit ?? 10).map(normalizeListing)
  };
}

async function searchViaHtml(args: SearchArgs) {
  const requestedLimit = Math.min(args.limit ?? 10, 300);
  const startOffset = args.offset ?? 0;
  const ads: NormalizedListing[] = [];
  const seen = new Set<string>();
  let total: number | undefined;
  let firstUrl = "";

  for (let pageOffset = startOffset; ads.length < requestedLimit; pageOffset = (Math.floor(pageOffset / PAGE_SIZE) + 1) * PAGE_SIZE) {
    const url = buildSearchUrl({ ...args, limit: PAGE_SIZE, offset: pageOffset });
    if (!firstUrl) firstUrl = url.toString();
    const res = await http(url.toString(), {
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        origin: "",
        referer: WEB_BASE
      }
    });
    const html = await res.text();
    if (!res.ok) throw new Error(`HTML search failed ${res.status}: ${html.slice(0, 220)}`);
    const data = parseNextData(html);
    const searchData = data?.props?.pageProps?.searchData ?? {};
    total = total ?? searchData.total ?? searchData.total_all;
    const pageAds = [...(searchData.ads ?? []), ...(searchData.ads_alu ?? [])].map(normalizeListing);
    const offsetInsidePage = pageOffset === startOffset ? startOffset % PAGE_SIZE : 0;
    const usableAds = pageAds.slice(offsetInsidePage);

    if (!usableAds.length) break;
    for (const ad of usableAds) {
      if (!seen.has(ad.id)) {
        seen.add(ad.id);
        ads.push(ad);
        if (ads.length >= requestedLimit) break;
      }
    }
    if (total !== undefined && pageOffset + PAGE_SIZE >= total) break;
  }

  return { source: "html", total, ads, url: firstUrl };
}

async function search(args: SearchArgs) {
  return await searchViaHtml(args);
}

async function batchSearch(args: {
  searches: SearchArgs[];
  limitPerSearch?: number;
  maxResults?: number;
}) {
  const searches = args.searches.map((searchArgs) => ({
    ...searchArgs,
    limit: Math.min(searchArgs.limit ?? args.limitPerSearch ?? 10, 300)
  }));
  const results = await Promise.all(searches.map((searchArgs) => search(searchArgs)));
  const adsById = new Map<string, NormalizedListing & { matchedQueries: string[] }>();

  for (let index = 0; index < results.length; index += 1) {
    const query = searches[index].query;
    for (const ad of results[index].ads) {
      const existing = adsById.get(ad.id);
      if (existing) {
        if (!existing.matchedQueries.includes(query)) existing.matchedQueries.push(query);
      } else {
        adsById.set(ad.id, { ...ad, matchedQueries: [query] });
      }
    }
  }

  const ads = Array.from(adsById.values())
    .sort((a, b) => (a.price ?? Number.MAX_SAFE_INTEGER) - (b.price ?? Number.MAX_SAFE_INTEGER))
    .slice(0, args.maxResults ?? 100);

  return {
    count: ads.length,
    searchCount: searches.length,
    sources: results.map((r) => r.source),
    totals: results.map((r, index) => ({ query: searches[index].query, total: r.total })),
    ads
  };
}

function extractListingId(input: string) {
  const match = input.match(/(\d{8,})/);
  if (!match) throw new Error(`Could not extract a Leboncoin listing id from: ${input}`);
  return match[1];
}

async function getDetails(idOrUrl: string) {
  const id = extractListingId(idOrUrl);
  const res = await http(`${API_BASE}/finder/classified/${id}`, {
    headers: { referer: `${WEB_BASE}/ad/${id}` }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Details endpoint failed ${res.status}: ${text.slice(0, 220)}`);
  return normalizeListing(JSON.parse(text));
}

async function getDetailsBatch(listings: string[]) {
  const uniqueListings = Array.from(new Set(listings.map((listing) => listing.trim()).filter(Boolean)));
  const settled = await Promise.allSettled(uniqueListings.map((listing) => getDetails(listing)));
  return {
    count: settled.filter((result) => result.status === "fulfilled").length,
    failedCount: settled.filter((result) => result.status === "rejected").length,
    listings: settled.map((result, index) =>
      result.status === "fulfilled"
        ? { ok: true, input: uniqueListings[index], listing: result.value }
        : {
            ok: false,
            input: uniqueListings[index],
            error: result.reason instanceof Error ? result.reason.message : String(result.reason)
          }
    )
  };
}

function stats(values: number[]) {
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
  return { average: avg, stdev: Math.sqrt(variance), min: Math.min(...values), max: Math.max(...values) };
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

type OAuthCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  expiresAt: number;
};

type OAuthToken = {
  clientId: string;
  resource: string;
  scope: string;
  expiresAt: number;
};

const oauthCodes = new Map<string, OAuthCode>();
const oauthTokens = new Map<string, OAuthToken>();

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function sha256Base64Url(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function parseScopes(scope?: string | null) {
  const requested = (scope ?? oauthScopes.join(" ")).split(/\s+/).filter(Boolean);
  return requested.filter((scopeName) => oauthScopes.includes(scopeName));
}

function protectedResourceMetadata() {
  return {
    resource: publicBaseUrl,
    authorization_servers: [oauthIssuer],
    scopes_supported: oauthScopes,
    bearer_methods_supported: ["header"],
    resource_documentation: `${publicBaseUrl}/health`
  };
}

function authorizationServerMetadata() {
  return {
    issuer: oauthIssuer,
    authorization_endpoint: `${oauthIssuer}/authorize`,
    token_endpoint: `${oauthIssuer}/token`,
    client_id_metadata_document_supported: true,
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    scopes_supported: oauthScopes
  };
}

function sendUnauthorized(res: ServerResponse) {
  res.writeHead(401, {
    "WWW-Authenticate": `Bearer resource_metadata="${publicBaseUrl}/.well-known/oauth-protected-resource", scope="${oauthScopes.join(" ")}"`,
    "content-type": "application/json"
  });
  res.end(JSON.stringify({ error: "unauthorized", resource_metadata: `${publicBaseUrl}/.well-known/oauth-protected-resource` }));
}

function requiresOAuth(req: IncomingMessage) {
  if (!oauthEnabled) return false;

  const host = req.headers.host?.toLowerCase();
  const forwardedHost = typeof req.headers["x-forwarded-host"] === "string" ? req.headers["x-forwarded-host"].toLowerCase() : undefined;

  return host === publicHost || forwardedHost === publicHost;
}

function verifyOAuthRequest(req: IncomingMessage, res: ServerResponse) {
  if (!requiresOAuth(req)) return true;
  const auth = req.headers.authorization;
  const match = typeof auth === "string" ? auth.match(/^Bearer\s+(.+)$/i) : undefined;
  if (!match) {
    sendUnauthorized(res);
    return false;
  }
  const token = oauthTokens.get(match[1]);
  if (!token || token.expiresAt <= Date.now() || token.resource !== publicBaseUrl) {
    sendUnauthorized(res);
    return false;
  }
  return true;
}

async function readWatches(): Promise<Record<string, { args: SearchArgs; seenIds: string[]; lastChecked?: string }>> {
  try {
    return JSON.parse(await readFile(WATCHES_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function writeWatches(watches: Record<string, { args: SearchArgs; seenIds: string[]; lastChecked?: string }>) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(WATCHES_FILE, JSON.stringify(watches, null, 2));
}

const searchSchema = {
  query: z.string().min(1),
  category: z.string().optional(),
  minPrice: z.number().optional(),
  maxPrice: z.number().optional(),
  departments: z.array(z.string()).optional(),
  zipcodes: z.array(z.string()).optional(),
  regions: z.array(z.string()).optional(),
  ownerType: z.enum(["all", "private", "pro"]).default("all"),
  sortBy: z.enum(["time", "price", "relevance"]).default("time"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  limit: z.number().int().min(1).max(300).default(10),
  offset: z.number().int().min(0).default(0)
};

const batchSearchItemSchema = {
  ...searchSchema,
  ownerType: z.enum(["all", "private", "pro"]).optional(),
  sortBy: z.enum(["time", "price", "relevance"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
  limit: z.number().int().min(1).max(300).optional(),
  offset: z.number().int().min(0).optional()
};

function createLeboncoinServer() {
const server = new McpServer({ name: "leboncoin-mcp", version: "1.0.0" });

server.tool("check_endpoints", "Probe Leboncoin endpoints and return current HTTP status plus payload templates.", {}, async () => {
  const sample: SearchArgs = { query: "macbook", limit: 3 };
  const checks: Record<string, unknown> = {};
  for (const [name, run] of Object.entries({
    searchApi: () => searchViaApi(sample),
    searchHtml: () => searchViaHtml(sample),
    detailApi: () => getDetails("3194209348")
  })) {
    try {
      const result = await run();
      checks[name] = { ok: true, source: (result as { source?: string }).source, sampleKeys: Object.keys(result).slice(0, 8) };
    } catch (error) {
      checks[name] = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return textResult({
    endpoints: {
      search: { method: "POST", url: `${API_BASE}/finder/search`, payload: buildSearchPayload(sample) },
      searchFallback: { method: "GET", url: buildSearchUrl(sample).toString(), parser: "__NEXT_DATA__.props.pageProps.searchData.ads" },
      details: { method: "GET", url: `${API_BASE}/finder/classified/{list_id}` },
      phone: { method: "GET", url: `${API_BASE}/api/utils/phonenumber.json`, note: "Requires authenticated session; intentionally not implemented." }
    },
    checks
  });
});

server.tool("search_listings", "Search Leboncoin listings using regular HTTP with SSR fallback when API search is blocked.", searchSchema, async (args) =>
  textResult(await search(args))
);

server.tool(
  "batch_search_listings",
  "Run multiple Leboncoin searches in one MCP call, in parallel, then merge and deduplicate listings by ID.",
  {
    searches: z.array(z.object(batchSearchItemSchema)).min(1).max(20),
    limitPerSearch: z.number().int().min(1).max(300).default(10),
    maxResults: z.number().int().min(1).max(300).default(100)
  },
  async (args) => textResult(await batchSearch(args))
);

server.tool(
  "get_listing_details",
  "Fetch full details for one Leboncoin listing from a listing URL or numeric ID.",
  { listing: z.string().min(1) },
  async ({ listing }) => textResult(await getDetails(listing))
);

server.tool(
  "get_listing_details_batch",
  "Fetch full details for many Leboncoin listings from listing URLs or numeric IDs in one MCP call.",
  { listings: z.array(z.string().min(1)).min(1).max(50) },
  async ({ listings }) => textResult(await getDetailsBatch(listings))
);

server.tool(
  "analyze_market_price",
  "Analyze whether a target listing or target price is cheap, fair, or expensive compared with similar search results.",
  {
    query: z.string().min(1),
    listing: z.string().optional(),
    targetPrice: z.number().optional(),
    category: z.string().optional(),
    departments: z.array(z.string()).optional(),
    zipcodes: z.array(z.string()).optional(),
    limit: z.number().int().min(5).max(35).default(30)
  },
  async (args) => {
    const target = args.listing ? await getDetails(args.listing) : undefined;
    const targetPrice = args.targetPrice ?? target?.price;
    if (!targetPrice) throw new Error("Provide targetPrice or a listing that has a price.");
    const results = await search({
      query: args.query,
      category: args.category,
      departments: args.departments,
      zipcodes: args.zipcodes,
      limit: args.limit,
      sortBy: "relevance"
    });
    const comparable = results.ads
      .filter((ad) => ad.id !== target?.id && typeof ad.price === "number" && ad.price > 0)
      .map((ad) => ad.price as number);
    if (comparable.length < 3) throw new Error("Not enough comparable priced listings were found.");
    const s = stats(comparable);
    const delta = targetPrice - s.average;
    const percent = (delta / s.average) * 100;
    const rating = percent <= -15 ? "good_deal" : percent >= 15 ? "expensive" : "fair";
    return textResult({ rating, target, targetPrice, market: s, delta, percent, comparableCount: comparable.length, source: results.source });
  }
);

server.tool(
  "search_multi_region",
  "Run the same Leboncoin search across multiple departments or zipcodes and merge/deduplicate results.",
  {
    query: z.string().min(1),
    category: z.string().optional(),
    departments: z.array(z.string()).default([]),
    zipcodes: z.array(z.string()).default([]),
    minPrice: z.number().optional(),
    maxPrice: z.number().optional(),
    limitPerRegion: z.number().int().min(1).max(20).default(10)
  },
  async (args) => {
    const scopes = [
      ...args.departments.map((department) => ({ departments: [department] })),
      ...args.zipcodes.map((zipcode) => ({ zipcodes: [zipcode] }))
    ];
    const searches = scopes.length ? scopes : [{}];
    const results = await Promise.all(
      searches.map((scope) =>
        search({ ...args, ...scope, limit: args.limitPerRegion, sortBy: "time", ownerType: "all", sortOrder: "desc" })
      )
    );
    const seen = new Set<string>();
    const ads = results.flatMap((r) => r.ads).filter((ad) => (seen.has(ad.id) ? false : (seen.add(ad.id), true)));
    return textResult({ count: ads.length, sources: results.map((r) => r.source), ads });
  }
);

server.tool(
  "watch_new_listings",
  "Create or check a persistent local watch and return listings not seen in previous checks.",
  {
    watchName: z.string().min(1),
    query: z.string().min(1),
    category: z.string().optional(),
    minPrice: z.number().optional(),
    maxPrice: z.number().optional(),
    departments: z.array(z.string()).optional(),
    zipcodes: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(35).default(20),
    resetSeen: z.boolean().default(false)
  },
  async ({ watchName, resetSeen, ...args }) => {
    const watches = await readWatches();
    const current = watches[watchName] ?? { args, seenIds: [] };
    current.args = args;
    if (resetSeen) current.seenIds = [];
    const results = await search({ ...args, sortBy: "time", sortOrder: "desc", ownerType: "all" });
    const seen = new Set(current.seenIds);
    const fresh = results.ads.filter((ad) => !seen.has(ad.id));
    current.seenIds = Array.from(new Set([...results.ads.map((ad) => ad.id), ...current.seenIds])).slice(0, 500);
    current.lastChecked = new Date().toISOString();
    watches[watchName] = current;
    await writeWatches(watches);
    return textResult({ watchName, newCount: fresh.length, newListings: fresh, checkedCount: results.ads.length, source: results.source });
  }
);

return server;
}

async function readJsonBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : undefined;
}

async function readTextBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readFormBody(req: IncomingMessage) {
  const body = await readTextBody(req);
  if ((req.headers["content-type"] ?? "").toString().includes("application/json")) {
    const json = JSON.parse(body || "{}") as Record<string, string | undefined>;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(json)) {
      if (value !== undefined) params.set(key, value);
    }
    return params;
  }
  return new URLSearchParams(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function handleOAuthAuthorize(url: URL, res: ServerResponse) {
  const responseType = url.searchParams.get("response_type");
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const codeChallenge = url.searchParams.get("code_challenge");
  const codeChallengeMethod = url.searchParams.get("code_challenge_method");
  const state = url.searchParams.get("state");
  const resource = url.searchParams.get("resource") ?? publicBaseUrl;
  const scope = parseScopes(url.searchParams.get("scope")).join(" ");

  if (responseType !== "code" || !clientId || !redirectUri || !codeChallenge || codeChallengeMethod !== "S256") {
    sendJson(res, 400, { error: "invalid_request" });
    return;
  }
  if (resource !== publicBaseUrl) {
    sendJson(res, 400, { error: "invalid_target", expected_resource: publicBaseUrl });
    return;
  }

  const code = randomToken();
  oauthCodes.set(code, {
    clientId,
    redirectUri,
    codeChallenge,
    resource,
    scope,
    expiresAt: Date.now() + 5 * 60 * 1000
  });

  sendHtml(
    res,
    200,
    `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Authorize Leboncoin MCP</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 640px; margin: 48px auto; line-height: 1.4;">
  <h1>Authorize Leboncoin MCP</h1>
  <p>ChatGPT is requesting access to the Leboncoin MCP tools.</p>
  <p><strong>Scopes:</strong> ${scope || oauthScopes.join(" ")}</p>
  <form method="get" action="${escapeHtml(redirectUri)}">
    <input type="hidden" name="code" value="${escapeHtml(code)}">
    ${state ? `<input type="hidden" name="state" value="${escapeHtml(state)}">` : ""}
    <button type="submit" style="font-size: 16px; padding: 10px 16px;">Authorize</button>
  </form>
</body>
</html>`
  );
}

async function handleOAuthToken(req: IncomingMessage, res: ServerResponse) {
  const form = await readFormBody(req);
  const grantType = form.get("grant_type");
  const code = form.get("code") ?? "";
  const redirectUri = form.get("redirect_uri");
  const clientId = form.get("client_id");
  const verifier = form.get("code_verifier") ?? "";
  const resource = form.get("resource") ?? publicBaseUrl;
  const saved = oauthCodes.get(code);

  if (grantType !== "authorization_code" || !saved || saved.expiresAt <= Date.now()) {
    console.error("OAuth token invalid_grant", { reason: "missing_or_expired_code", grantType, hasSavedCode: Boolean(saved) });
    sendJson(res, 400, { error: "invalid_grant" });
    return;
  }
  if (saved.redirectUri !== redirectUri || (clientId && saved.clientId !== clientId) || saved.resource !== resource) {
    console.error("OAuth token invalid_grant", {
      reason: "mismatch",
      savedRedirectUri: saved.redirectUri,
      redirectUri,
      savedClientId: saved.clientId,
      clientId,
      savedResource: saved.resource,
      resource
    });
    sendJson(res, 400, { error: "invalid_grant" });
    return;
  }
  if (sha256Base64Url(verifier) !== saved.codeChallenge) {
    console.error("OAuth token invalid_grant", { reason: "pkce_mismatch", hasVerifier: Boolean(verifier) });
    sendJson(res, 400, { error: "invalid_grant" });
    return;
  }

  oauthCodes.delete(code);
  const accessToken = randomToken();
  oauthTokens.set(accessToken, {
    clientId: saved.clientId,
    resource: saved.resource,
    scope: saved.scope,
    expiresAt: Date.now() + oauthTokenTtlSeconds * 1000
  });

  sendJson(res, 200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: oauthTokenTtlSeconds,
    scope: saved.scope
  });
}

async function runHttpServer() {
  const port = Number(process.env.PORT ?? 3000);
  const transports: Record<string, StreamableHTTPServerTransport | SSEServerTransport> = {};

  const httpServer = nodeHttp.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, name: "leboncoin-mcp", transports: ["/mcp", "/sse"], oauth: oauthEnabled });
      return;
    }

    if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
      sendJson(res, 200, protectedResourceMetadata());
      return;
    }

    if (
      req.method === "GET" &&
      (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration")
    ) {
      sendJson(res, 200, authorizationServerMetadata());
      return;
    }

    if (req.method === "GET" && url.pathname === "/authorize") {
      handleOAuthAuthorize(url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/token") {
      await handleOAuthToken(req, res);
      return;
    }

    if (url.pathname === "/mcp") {
      if (!verifyOAuthRequest(req, res)) return;
      try {
        const sessionId = req.headers["mcp-session-id"];
        let transport: StreamableHTTPServerTransport | undefined;

        if (typeof sessionId === "string" && transports[sessionId] instanceof StreamableHTTPServerTransport) {
          transport = transports[sessionId] as StreamableHTTPServerTransport;
        } else {
          const body = req.method === "POST" ? await readJsonBody(req) : undefined;
          if (req.method === "POST" && isInitializeRequest(body)) {
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (newSessionId) => {
                if (transport) transports[newSessionId] = transport;
              }
            });
            transport.onclose = () => {
              const sid = transport?.sessionId;
              if (sid) delete transports[sid];
            };
            await createLeboncoinServer().connect(transport);
            await transport.handleRequest(req, res, body);
            return;
          }
          sendJson(res, 400, {
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: initialize first or provide a valid MCP session id" },
            id: null
          });
          return;
        }

        const body = req.method === "POST" ? await readJsonBody(req) : undefined;
        await transport.handleRequest(req, res, body);
        return;
      } catch (error) {
        if (!res.headersSent) {
          sendJson(res, 500, {
            jsonrpc: "2.0",
            error: { code: -32603, message: error instanceof Error ? error.message : "Internal server error" },
            id: null
          });
        }
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/sse") {
      if (!verifyOAuthRequest(req, res)) return;
      const transport = new SSEServerTransport("/messages", res);
      transports[transport.sessionId] = transport;
      res.on("close", () => delete transports[transport.sessionId]);
      await createLeboncoinServer().connect(transport);
      return;
    }

    if (req.method === "POST" && url.pathname === "/messages") {
      if (!verifyOAuthRequest(req, res)) return;
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const transport = transports[sessionId];
      if (transport instanceof SSEServerTransport) {
        await transport.handlePostMessage(req, res);
      } else {
        sendJson(res, 400, { error: "No SSE transport found for sessionId" });
      }
      return;
    }

    sendJson(res, 404, { error: "Not found", endpoints: ["/health", "/mcp", "/sse", "/messages"] });
  });

  httpServer.listen(port, "0.0.0.0", () => {
    console.error(`Leboncoin MCP HTTP server listening on http://0.0.0.0:${port}`);
    console.error(`Streamable HTTP: /mcp`);
    console.error(`SSE compatibility: /sse`);
  });
}

const transportMode = process.env.MCP_TRANSPORT ?? "stdio";
if (transportMode === "http") {
  await runHttpServer();
} else {
  await createLeboncoinServer().connect(new StdioServerTransport());
}
