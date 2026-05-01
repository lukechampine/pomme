"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.node.ts
var index_node_exports = {};
__export(index_node_exports, {
  AppKey: () => AppKey,
  Builder: () => Builder,
  ObjectEvent: () => ObjectEvent,
  PackedUpload: () => PackedUpload,
  PinnedObject: () => PinnedObject,
  Sdk: () => Sdk,
  encodedSize: () => encodedSize,
  generateRecoveryPhrase: () => generateRecoveryPhrase,
  initSia: () => initSia,
  setLogger: () => setLogger,
  validateRecoveryPhrase: () => validateRecoveryPhrase
});
module.exports = __toCommonJS(index_node_exports);

// src/node/load.ts
var addon = null;
function loadNativeAddon() {
  if (addon) return addon;
  const platform = process.platform;
  const arch = process.arch;
  try {
    if (platform === "darwin" && arch === "arm64") {
      addon = require("@siafoundation/sia-storage-darwin-arm64");
    } else if (platform === "darwin" && arch === "x64") {
      addon = require("@siafoundation/sia-storage-darwin-x64");
    } else if (platform === "linux" && arch === "x64") {
      addon = require("@siafoundation/sia-storage-linux-x64-gnu");
    } else if (platform === "linux" && arch === "arm64") {
      addon = require("@siafoundation/sia-storage-linux-arm64-gnu");
    } else if (platform === "win32" && arch === "x64") {
      addon = require("@siafoundation/sia-storage-win32-x64-msvc");
    }
  } catch {
  }
  if (!addon) {
    throw new Error(
      `@siafoundation/sia-storage: Native addon not found for ${platform}-${arch}. Install @siafoundation/sia-storage-${platform}-${arch} or use the browser/WASM build.`
    );
  }
  return addon;
}

// src/node/napi.ts
var addon2 = loadNativeAddon();
var {
  AppKey,
  Builder,
  Sdk,
  PinnedObject,
  PackedUpload,
  ObjectEvent,
  generateRecoveryPhrase,
  validateRecoveryPhrase,
  setLogger,
  encodedSize
} = addon2;
async function initSia() {
  loadNativeAddon();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AppKey,
  Builder,
  ObjectEvent,
  PackedUpload,
  PinnedObject,
  Sdk,
  encodedSize,
  generateRecoveryPhrase,
  initSia,
  setLogger,
  validateRecoveryPhrase
});
//# sourceMappingURL=index.node.cjs.map