/*
 * index.js - entry point. Azure Functions v4 (Node) discovers registrations by
 * loading this module (package.json "main"). Requiring the function modules runs
 * their df.app.* / app.http registrations.
 */

"use strict";

require("./functions/orchestrator");
require("./functions/activities");
require("./functions/http");
require("./functions/cuaRun");
