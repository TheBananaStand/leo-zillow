# leo-zillow-mcp

Zillow real estate as a Leo package, over MCP — property search, Zestimates,
comparables and recently sold, from the Real-Time Zillow Data API on RapidAPI.

This is the same integration as the compiled `leo-zillow` package, reachable as
a package the hub **installs at runtime** rather than one it has to be rebuilt
for. Install it from the Store; there is nothing to compile.

## Tools

| Tool | Requires | Upstream |
|---|---|---|
| `search` | `location` | `propertyExtendedSearch` |
| `details` | `zpid` | `property` |
| `estimate` | `address` | `propertyExtendedSearch` |
| `comparables` | `zpid` | `similarProperty` |
| `sold` | `location` | `propertyExtendedSearch` (`status=recentlySold`) |

`search` also takes `status`, `price_min`, `price_max`, `beds_min`,
`baths_min`, `home_type`. `sold` takes `price_min`, `price_max` and
`months_back`, which is translated to the upstream's `daysOnZillow`.

The compiled package exposed one `zillow` tool with an `action` enum and a
ten-field union schema, most of it irrelevant to whichever action was chosen.
MCP names tools, so each action is its own tool with only its own parameters —
the model is told `zpid` is required for `details` by the schema rather than by
prose it has to obey.

Responses are forwarded as the upstream JSON text, **unparsed**. The shape is
wide and changes without notice; normalising it here would silently drop fields
the model could have used.

## Configuration

One setting, `zillow_rapidapi_key` — a [RapidAPI](https://rapidapi.com) key
subscribed to *Real-Time Zillow Data*. Leo hands an entitled setting to this
process under its settings key **verbatim and lower-case**, so the descriptor's
`settings_read` and `process.env.zillow_rapidapi_key` have to agree or the
credential silently never arrives.

Without it the server still starts and still lists its tools; every call
answers with the setting named and where to enter it. A server that refused to
launch would show up as a broken package rather than an unconfigured one.

## What it sends, and where

To `real-time-zillow-data.p.rapidapi.com`, and nowhere else: the place you are
asking about — a city, ZIP or street address — plus any price and bedroom
filters. That is declared as **`location`** as well as `search_queries`,
because searching for a home says where you live or intend to. No conversation,
file or account data is attached.

## Development

```bash
npm install
node test.js        # no network needed
```

The test covers the two things here that fail *quietly*: query building (an
absent filter must stay absent — `URLSearchParams` renders `undefined` as the
literal text "undefined", which the upstream then honours as a filter) and the
per-tool required-parameter check (which answers locally, so a forgotten
parameter costs nothing against the RapidAPI quota).

## Publishing

```bash
./store/publish.sh          # live
./store/publish.sh draft    # stage for review at admin.leoconnect.io
```

Needs a Cloudflare login with `D1:Edit` on the `leo-store` database. The script
refuses to publish unless the commit pinned in `store/registry-entry.json` is
both real and pushed — a SHA that resolves nowhere installs cleanly and then
fails on every hub at first launch, which is the one failure it can prevent and
nothing downstream can.
