"use strict";

// foundryOwners against a fake TableClient (NOT Azure Storage): insert-only claim, 404 -> null.
const test = require("node:test");
const assert = require("node:assert/strict");
const tables = require("@azure/data-tables");

test("claim writes once per request and owner() returns the recorded principal or null", async () => {
  const rows = new Map();
  const original = tables.TableClient.fromConnectionString;
  tables.TableClient.fromConnectionString = () => ({
    createTable: async () => undefined,
    createEntity: async (e) => {
      if (rows.has(e.rowKey)) throw Object.assign(new Error("exists"), { statusCode: 409 });
      rows.set(e.rowKey, e);
    },
    getEntity: async (_p, r) => {
      if (!rows.has(r)) throw Object.assign(new Error("missing"), { statusCode: 404 });
      return rows.get(r);
    }
  });
  try {
    const { tableOwners } = require("../src/foundryOwners");
    const owners = tableOwners({ AzureWebJobsStorage: "UseDevelopmentStorage=true" });
    assert.equal(await owners.owner("REQ-2026-0001"), null);
    assert.equal(await owners.claim("REQ-2026-0001", "t:alice"), true);
    assert.equal(await owners.claim("REQ-2026-0001", "t:bob"), false);
    assert.equal(await owners.owner("REQ-2026-0001"), "t:alice");
    await assert.rejects(tableOwners({}).owner("REQ-2026-0001"));
  } finally {
    tables.TableClient.fromConnectionString = original;
  }
});
