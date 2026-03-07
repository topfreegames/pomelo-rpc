/**
 * TCP handshake for RPC connection: negotiate compression and future options.
 * Format: single newline-terminated JSON line per message.
 *
 * Compatibility when only one side is upgraded:
 * - Old client → new server: OK. Server times out waiting for handshake, treats as legacy, continues.
 * - New client → old server: Old server may misparse the handshake line and break. Use client
 *   option handshake: false (in mailbox opts) when connecting to legacy servers so the client
 *   skips the handshake and uses plain Composer.
 */

var COMPRESSION_NONE = 'none';
var COMPRESSION_DEFLATE = 'deflate';
var COMPRESSION_LZ4 = 'lz4';
var COMPRESSION_SNAPPY = 'snappy';
var HANDSHAKE_VERSION = 2;

var DEFAULT_COMPRESSION_LIST = [
  COMPRESSION_NONE,
  COMPRESSION_DEFLATE,
  COMPRESSION_LZ4,
  COMPRESSION_SNAPPY
];
var HANDSHAKE_TIMEOUT_MS = 2000;

/**
 * Build client handshake payload (what client sends to server).
 * @param {Object} opts - opts.compression: optional array of supported compression (default ['none','deflate'])
 * @returns {Buffer} newline-terminated JSON
 */
function serializeClientHandshake(opts) {
  opts = opts || {};
  var compression = opts.compression;
  if (!Array.isArray(compression) || compression.length === 0) {
    compression = DEFAULT_COMPRESSION_LIST.slice();
  }
  var msg = { v: HANDSHAKE_VERSION, compression: compression };
  return Buffer.from(JSON.stringify(msg) + '\n', 'utf8');
}

/**
 * Parse first line from buffer as server handshake response.
 * @param {Buffer} buf - data received (may contain more after \n)
 * @returns {{ msg: Object, remainder: Buffer } | null} parsed handshake and remainder, or null
 */
function parseServerHandshake(buf) {
  var idx = buf.indexOf('\n');
  if (idx < 0) return null;
  var line = buf.toString('utf8', 0, idx);
  var remainder = buf.length > idx + 1 ? buf.slice(idx + 1) : null;
  try {
    var msg = JSON.parse(line);
    if (msg && msg.v === HANDSHAKE_VERSION && typeof msg.compression === 'string') {
      return { msg: msg, remainder: remainder };
    }
  } catch (e) {}
  return null;
}

/**
 * Build server handshake response (what server sends to client).
 * @param {string} compression - chosen compression: 'none' or 'deflate'
 * @returns {Buffer} newline-terminated JSON
 */
function serializeServerHandshake(compression) {
  var msg = { v: HANDSHAKE_VERSION, compression: compression || COMPRESSION_NONE };
  return Buffer.from(JSON.stringify(msg) + '\n', 'utf8');
}

/**
 * Parse first line from buffer as client handshake.
 * @param {Buffer} buf
 * @returns {{ msg: Object, remainder: Buffer } | null}
 */
function parseClientHandshake(buf) {
  var idx = buf.indexOf('\n');
  if (idx < 0) return null;
  var line = buf.toString('utf8', 0, idx);
  var remainder = buf.length > idx + 1 ? buf.slice(idx + 1) : null;
  try {
    var msg = JSON.parse(line);
    if (msg && msg.v === HANDSHAKE_VERSION && Array.isArray(msg.compression)) {
      return { msg: msg, remainder: remainder };
    }
  } catch (e) {}
  return null;
}

/**
 * Pick server compression: first overlap between server-supported and client-requested.
 * @param {string[]} serverSupported - e.g. ['none','deflate']
 * @param {string[]} clientRequested - from client handshake
 * @returns {string} chosen algorithm
 */
function negotiateCompression(serverSupported, clientRequested) {
  if (!Array.isArray(serverSupported)) serverSupported = DEFAULT_COMPRESSION_LIST.slice();
  if (!Array.isArray(clientRequested)) return COMPRESSION_NONE;
  for (var i = 0; i < serverSupported.length; i++) {
    if (clientRequested.indexOf(serverSupported[i]) !== -1) {
      return serverSupported[i];
    }
  }
  return COMPRESSION_NONE;
}

/**
 * Resolve negotiated compression to one that is actually available.
 * If the chosen algorithm cannot be loaded (optional dep missing), returns 'none'
 * or the first available from the client list. Pass getCompressor as the second arg.
 * @param {string} chosen - result of negotiateCompression
 * @param {string[]} clientRequested - client's compression list (to try next)
 * @param {function(string): object|null} getCompressor - compression.getCompressor
 * @returns {string} algorithm to use ('none' or one that getCompressor returns non-null for)
 */
function resolveCompression(chosen, clientRequested, getCompressor) {
  if (!getCompressor || chosen === COMPRESSION_NONE) return chosen;
  if (getCompressor(chosen)) return chosen;
  if (!Array.isArray(clientRequested)) return COMPRESSION_NONE;
  for (var i = 0; i < clientRequested.length; i++) {
    var alg = clientRequested[i];
    if (alg !== COMPRESSION_NONE && getCompressor(alg)) return alg;
  }
  return COMPRESSION_NONE;
}

module.exports = {
  COMPRESSION_NONE: COMPRESSION_NONE,
  COMPRESSION_DEFLATE: COMPRESSION_DEFLATE,
  COMPRESSION_LZ4: COMPRESSION_LZ4,
  COMPRESSION_SNAPPY: COMPRESSION_SNAPPY,
  DEFAULT_COMPRESSION_LIST: DEFAULT_COMPRESSION_LIST,
  HANDSHAKE_TIMEOUT_MS: HANDSHAKE_TIMEOUT_MS,
  serializeClientHandshake: serializeClientHandshake,
  serializeServerHandshake: serializeServerHandshake,
  parseClientHandshake: parseClientHandshake,
  parseServerHandshake: parseServerHandshake,
  negotiateCompression: negotiateCompression,
  resolveCompression: resolveCompression
};
