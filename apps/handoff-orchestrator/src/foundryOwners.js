/*
 * foundryOwners.js - durable "request -> owner" record for the Foundry relay, in the
 * Function App's existing storage account (AzureWebJobsStorage). claim() writes exactly
 * once per request id (insert-only), so a second start of the same request is refused;
 * owner() returns the recorded "tid:oid" or null.
 */

"use strict";

const { TableClient } = require("@azure/data-tables");

const TABLE = "foundryrelayowners";
const PARTITION = "foundry";

function tableOwners(env = process.env) {
  let ready = null;
  const client = () => {
    if (!env.AzureWebJobsStorage) throw new Error("No storage is configured for request ownership.");
    if (!ready) {
      const table = TableClient.fromConnectionString(env.AzureWebJobsStorage, TABLE);
      ready = table.createTable().then(() => table, (err) => {
        ready = null;
        throw err;
      });
    }
    return ready;
  };
  return {
    async claim(requestId, principal) {
      const table = await client();
      try {
        await table.createEntity({ partitionKey: PARTITION, rowKey: requestId, owner: principal });
        return true;
      } catch (err) {
        if (err && err.statusCode === 409) return false;
        throw err;
      }
    },
    async owner(requestId) {
      const table = await client();
      try {
        const row = await table.getEntity(PARTITION, requestId);
        return typeof row.owner === "string" ? row.owner : null;
      } catch (err) {
        if (err && err.statusCode === 404) return null;
        throw err;
      }
    }
  };
}

module.exports = { tableOwners };
