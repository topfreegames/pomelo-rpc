/**
 * Optional compression for TCP RPC. Each algorithm is lazy-loaded so optional
 * dependencies are only required when that algorithm is negotiated.
 * Built-in: deflate (zlib). Optional: lz4, snappy.
 */

var zlib = require('zlib');

var cache = {};

function loadDeflate() {
  return {
    createCompressStream: function() {
      return zlib.createDeflate({ level: zlib.Z_DEFAULT_COMPRESSION });
    },
    createDecompressStream: function() {
      return zlib.createInflate();
    },
    flush: function(stream) {
      if (stream && stream.flush) stream.flush();
    }
  };
}

function loadLz4() {
  if (cache.lz4 !== undefined) return cache.lz4;
  try {
    var lz4 = require('lz4');
    cache.lz4 = {
      createCompressStream: function() {
        return lz4.createEncoderStream();
      },
      createDecompressStream: function() {
        return lz4.createDecoderStream();
      },
      flush: function(stream) {
        if (stream && stream.flush) stream.flush();
      }
    };
    return cache.lz4;
  } catch (e) {
    cache.lz4 = null;
    return null;
  }
}

function loadSnappy() {
  if (cache.snappy !== undefined) return cache.snappy;
  try {
    var snappyStream = require('snappy-stream');
    cache.snappy = {
      createCompressStream: function() {
        return snappyStream.createCompressStream();
      },
      createDecompressStream: function() {
        return snappyStream.createUncompressStream();
      },
      flush: function(stream) {
        if (stream && stream.flush) stream.flush();
      }
    };
    return cache.snappy;
  } catch (e) {
    cache.snappy = null;
    return null;
  }
}

/**
 * Get compressor for an algorithm, or null if not available.
 * @param {string} algorithm - 'deflate' | 'lz4' | 'snappy'
 * @returns {{ createCompressStream, createDecompressStream, flush } | null}
 */
function getCompressor(algorithm) {
  switch (algorithm) {
    case 'deflate':
      return loadDeflate();
    case 'lz4':
      return loadLz4();
    case 'snappy':
      return loadSnappy();
    default:
      return null;
  }
}

module.exports = {
  getCompressor: getCompressor
};
