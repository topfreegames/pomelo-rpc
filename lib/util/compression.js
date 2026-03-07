/**
 * Optional compression for TCP RPC. Each algorithm is lazy-loaded so optional
 * dependencies are only required when that algorithm is negotiated.
 * Built-in: deflate (zlib). Optional: lz4, snappy.
 */

var zlib = require('zlib');
var stream = require('stream');

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
    var snappy = require('snappy');

    var SnappyCompress = function() {
      stream.Transform.call(this);
    };
    require('util').inherits(SnappyCompress, stream.Transform);
    SnappyCompress.prototype._transform = function(chunk, encoding, cb) {
      try {
        var compressed = snappy.compressSync(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
        var len = Buffer.allocUnsafe(4);
        len.writeUInt32LE(compressed.length, 0);
        this.push(Buffer.concat([len, compressed]));
      } catch (err) {
        return cb(err);
      }
      cb();
    };

    var SnappyDecompress = function() {
      stream.Transform.call(this);
      this._buffer = Buffer.alloc(0);
    };
    require('util').inherits(SnappyDecompress, stream.Transform);
    SnappyDecompress.prototype._transform = function(chunk, encoding, cb) {
      this._buffer = Buffer.concat([this._buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)]);
      try {
        while (this._buffer.length >= 4) {
          var frameLen = this._buffer.readUInt32LE(0);
          if (this._buffer.length < 4 + frameLen) break;
          var compressed = this._buffer.slice(4, 4 + frameLen);
          this._buffer = this._buffer.slice(4 + frameLen);
          this.push(snappy.uncompressSync(compressed));
        }
      } catch (err) {
        return cb(err);
      }
      cb();
    };

    cache.snappy = {
      createCompressStream: function() {
        return new SnappyCompress();
      },
      createDecompressStream: function() {
        return new SnappyDecompress();
      },
      flush: function(s) {
        if (s && s.flush) s.flush();
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
