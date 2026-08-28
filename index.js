#!/usr/bin/env node
//
// Leo real-estate package for Zillow, over MCP.
//
// The same Real-Time Zillow Data integration as the compiled `leo-zillow`
// package, reachable as a package the hub installs at runtime instead of one it
// is rebuilt for. Responses are forwarded as the upstream JSON text, unparsed —
// this server adds the key and the parameters and gets out of the way, which is
// exactly what the Rust package did.
//
// One difference from that package, deliberately. It exposed a single `zillow`
// tool with an `action` enum and a ten-field union schema, most of it
// irrelevant to whichever action was chosen. MCP names tools, so each action is
// its own tool with only its own parameters — the model is told `zpid` is
// required for `details` by the schema, rather than by prose it has to obey.
//
// Plain JavaScript on purpose. This ships as a git tarball rather than an npm
// package, and npm does not reliably run build steps for a tarball URL — a
// TypeScript source tree would install and then fail to start, at the far end,
// on somebody else's machine.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const RAPIDAPI_HOST = "real-time-zillow-data.p.rapidapi.com";

// Leo hands an entitled setting to the subprocess under its *settings key*,
// verbatim and lower-case — see `Entitlements::resolve_env_secrets`. This is
// the key the package's descriptor declares in `settings_read`, so the two
// spellings have to agree or the credential silently never arrives.
const SETTING_KEY = "zillow_rapidapi_key";

/**
 * Query values RapidAPI will accept, from what the model actually sends.
 *
 * A price or a bedroom count arrives as a JSON number about as often as a
 * string, and `URLSearchParams` would render the number fine but `undefined`
 * as the literal text "undefined" — a filter the upstream then honours. So
 * absent stays absent, and both scalar shapes are accepted.
 *
 * Exported for the smoke test: this is the whole of what can go quietly wrong
 * here, and it needs no network to check.
 */
export function toQuery(pairs) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(pairs)) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
      params.set(key, String(value));
    } else if (typeof value === "string") {
      params.set(key, value);
    }
    // Anything else — an object, an array, a boolean — is not a query value
    // the upstream understands, and guessing a rendering for it would send a
    // filter nobody asked for.
  }
  return params;
}

/**
 * `months_back` is how a person describes a sold-listings window; the upstream
 * parameter is `daysOnZillow`. Kept as a named function because it is a real
 * translation and not a rename, and because a wrong one returns plausible
 * results rather than an error.
 */
export function monthsToDaysOnZillow(months) {
  const n = Number(months);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return String(Math.round(n) * 30);
}

async function rapidGet(path, query) {
  const apiKey = process.env[SETTING_KEY] ?? "";
  if (!apiKey) {
    // Named precisely, because the failure the owner will actually hit is a
    // key they have not entered yet — not a broken server.
    throw new Error(
      `No ${SETTING_KEY} configured. Add it in Settings → Packages → Zillow.`,
    );
  }

  const url = `https://${RAPIDAPI_HOST}/${path}?${query.toString()}`;
  const response = await fetch(url, {
    headers: {
      "X-RapidAPI-Key": apiKey,
      "X-RapidAPI-Host": RAPIDAPI_HOST,
    },
  });

  if (!response.ok) {
    // The status is the part worth forwarding: 401 is a wrong key, 403 is a
    // plan that does not include this endpoint, and 429 is a quota. Those are
    // three different jobs for whoever reads the message.
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Zillow API returned ${response.status}: ${detail.slice(0, 200)}`,
    );
  }

  // Forwarded verbatim. The upstream shape is wide and changes without notice;
  // normalising it here would mean silently dropping fields the model could
  // have used, and every field it keeps is one more thing to get wrong.
  return await response.text();
}

const TOOLS = {
  search: {
    description:
      "Search Zillow listings by city, ZIP or address, with optional price, " +
      "bed, bath and property-type filters.",
    inputSchema: {
      type: "object",
      properties: {
        location: { type: "string", description: "City, ZIP code, or address." },
        status: {
          type: "string",
          description: "Listing status: for_sale, for_rent, or sold.",
        },
        price_min: { type: "string", description: "Minimum price." },
        price_max: { type: "string", description: "Maximum price." },
        beds_min: { type: "string", description: "Minimum bedrooms." },
        baths_min: { type: "string", description: "Minimum bathrooms." },
        home_type: {
          type: "string",
          description: "Property type: Houses, Townhomes, Condos, etc.",
        },
      },
      required: ["location"],
    },
    run: (a) =>
      rapidGet(
        "propertyExtendedSearch",
        toQuery({
          location: a.location,
          status: a.status,
          price_min: a.price_min,
          price_max: a.price_max,
          beds_min: a.beds_min,
          baths_min: a.baths_min,
          home_type: a.home_type,
        }),
      ),
  },

  details: {
    description: "Full detail for one property, by its Zillow Property ID.",
    inputSchema: {
      type: "object",
      properties: {
        zpid: { type: "string", description: "Zillow Property ID." },
      },
      required: ["zpid"],
    },
    run: (a) => rapidGet("property", toQuery({ zpid: a.zpid })),
  },

  estimate: {
    description:
      "Zestimate and rent estimate for a full property address.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Full property address." },
      },
      required: ["address"],
    },
    run: (a) =>
      rapidGet("propertyExtendedSearch", toQuery({ location: a.address })),
  },

  comparables: {
    description: "Properties comparable to a given Zillow Property ID.",
    inputSchema: {
      type: "object",
      properties: {
        zpid: { type: "string", description: "Zillow Property ID." },
      },
      required: ["zpid"],
    },
    run: (a) => rapidGet("similarProperty", toQuery({ zpid: a.zpid })),
  },

  sold: {
    description:
      "Recently sold properties in an area, optionally bounded by price and " +
      "how far back to look.",
    inputSchema: {
      type: "object",
      properties: {
        location: { type: "string", description: "City, ZIP code, or address." },
        price_min: { type: "string", description: "Minimum price." },
        price_max: { type: "string", description: "Maximum price." },
        months_back: {
          type: "integer",
          description: "How many months back to search.",
        },
      },
      required: ["location"],
    },
    run: (a) =>
      rapidGet(
        "propertyExtendedSearch",
        toQuery({
          location: a.location,
          status: "recentlySold",
          price_min: a.price_min,
          price_max: a.price_max,
          daysOnZillow: monthsToDaysOnZillow(a.months_back),
        }),
      ),
  },
};

/** Every tool declares its own required parameters; this enforces them. */
export function missingRequired(name, args) {
  const required = TOOLS[name]?.inputSchema?.required ?? [];
  return required.filter((key) => {
    const v = args?.[key];
    return v === undefined || v === null || v === "";
  });
}

const server = new Server(
  { name: "leo-zillow-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = TOOLS[name];
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
    };
  }
  const missing = missingRequired(name, args);
  if (missing.length > 0) {
    // Answered here rather than sent upstream, so a forgotten parameter costs
    // nothing against the RapidAPI quota and reads as what it is.
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `${name} requires: ${missing.join(", ")}`,
        },
      ],
    };
  }
  try {
    return { content: [{ type: "text", text: await tool.run(args ?? {}) }] };
  } catch (error) {
    // `isError` is what the hub reads to tell "the search found nothing" from
    // "the search did not run" — the bridge turns this into a real error
    // rather than an empty result set.
    return {
      isError: true,
      content: [{ type: "text", text: String(error?.message ?? error) }],
    };
  }
});

// Importing this file for its helpers must not also start a server on stdio.
if (process.env.LEO_ZILLOW_MCP_NO_SERVE !== "1") {
  await server.connect(new StdioServerTransport());
}
