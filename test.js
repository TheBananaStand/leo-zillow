// Smoke test for the things in this server that can fail quietly.
//
// The network call is RapidAPI's to get right. What is ours is the query
// building and the required-parameter check, and neither throws when wrong —
// a bad query returns a well-formed page of the wrong houses, and a missing
// required check spends quota to be told what we already knew. So that is
// what is checked here.
//
//   node test.js

process.env.LEO_ZILLOW_MCP_NO_SERVE = "1";

const { toQuery, monthsToDaysOnZillow, missingRequired } = await import(
  "./index.js"
);
const assert = await import("node:assert/strict");

// Absent stays absent. `URLSearchParams` renders undefined as the literal
// "undefined", which the upstream honours as a filter — the exact bug this
// helper exists to prevent.
{
  const q = toQuery({ location: "Austin, TX", price_min: undefined, beds_min: null, home_type: "" });
  assert.equal(q.toString(), "location=Austin%2C+TX");
}

// A number is as likely as a string from a model, and both must render.
{
  const q = toQuery({ price_min: 250000, beds_min: "3" });
  assert.equal(q.get("price_min"), "250000");
  assert.equal(q.get("beds_min"), "3");
}

// NaN/Infinity are numbers and would render as text the upstream can't parse.
{
  const q = toQuery({ price_max: Number.NaN, beds_min: Number.POSITIVE_INFINITY });
  assert.equal(q.toString(), "");
}

// Non-scalars are dropped rather than guessed at — an array would stringify to
// a comma list that means nothing to the API.
{
  const q = toQuery({ home_type: ["Houses", "Condos"], status: { a: 1 }, beds_min: true });
  assert.equal(q.toString(), "");
}

// months_back -> daysOnZillow is a translation, not a rename; a wrong one
// returns plausible results rather than an error.
{
  assert.equal(monthsToDaysOnZillow(6), "180");
  assert.equal(monthsToDaysOnZillow("3"), "90");
  assert.equal(monthsToDaysOnZillow(0), undefined);
  assert.equal(monthsToDaysOnZillow(-2), undefined);
  assert.equal(monthsToDaysOnZillow("soon"), undefined);
  assert.equal(monthsToDaysOnZillow(undefined), undefined);
}

// Each tool enforces its OWN required parameters — the reason for splitting the
// old single `zillow` tool up at all. `details` must not accept a location.
{
  assert.deepEqual(missingRequired("details", {}), ["zpid"]);
  assert.deepEqual(missingRequired("details", { location: "Austin" }), ["zpid"]);
  assert.deepEqual(missingRequired("details", { zpid: "123" }), []);

  assert.deepEqual(missingRequired("search", {}), ["location"]);
  assert.deepEqual(missingRequired("estimate", {}), ["address"]);
  assert.deepEqual(missingRequired("comparables", {}), ["zpid"]);
  assert.deepEqual(missingRequired("sold", {}), ["location"]);
}

// An empty string is missing, not present — it would search for nothing and
// come back with an unhelpful 200.
{
  assert.deepEqual(missingRequired("search", { location: "" }), ["location"]);
}

// An unknown tool has no required list; it must report none rather than throw,
// because the caller answers it as "Unknown tool" a line later.
{
  assert.deepEqual(missingRequired("nope", {}), []);
}

console.log("ok — query building and required-parameter checks hold");
