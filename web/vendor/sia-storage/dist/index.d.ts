export { Account, AppKey, AppMetadata, Builder, DownloadOptions, Host, HostQuery, ObjectEvent, PackedUpload, PinnedObject, PinnedSlab, Sdk, SealedObject, Sector, ShardProgress, Slab, UploadOptions, encodedSize, generateRecoveryPhrase, setLogger, validateRecoveryPhrase } from '../wasm/sia_storage_wasm.js';

/** Initialize the WASM module. Safe to call multiple times. */
declare function initSia(): Promise<void>;

export { initSia };
