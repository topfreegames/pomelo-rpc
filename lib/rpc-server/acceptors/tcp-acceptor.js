var EventEmitter = require('events').EventEmitter;
var util = require('util');
var utils = require('../../util/utils');
var net = require('net');
var Composer = require('../../util/composer');
var Tracer = require('../../util/tracer');
var handshake = require('../../util/tcp-handshake');
var compression = require('../../util/compression');
var logger = require('pomelo-logger').getLogger('pomelo-rpc', __filename);
var tracing = require('../../util/tracing');

var MSG_TYPE = 0;
var PING = 1;
var PONG = 2;
var RES_TYPE = 3;
var CLOSE_MSG = 4;

var Acceptor = function(opts, cb) {
  EventEmitter.call(this);
  opts = opts || {};
  this.bufferMsg = opts.bufferMsg;
  this.interval = opts.interval;  // flush interval in ms
  this.pkgSize = opts.pkgSize;
  this._interval = null;          // interval object
  this.compression = opts.compression || [handshake.COMPRESSION_NONE, handshake.COMPRESSION_DEFLATE];
  // Heartbeat ping interval.
  this.ping = 'ping' in opts ? opts.ping : 15000;

  //ping timer for each client connection
  this.timer = {};

  this.server = null;
  this.sockets = {};
  this.msgQueues = {};
  this.cb = cb;
  this.socketId = 0;

  this.rpcDebugLog = opts.rpcDebugLog;
  this.rpcLogger = opts.rpcLogger;
};
util.inherits(Acceptor, EventEmitter);

var pro = Acceptor.prototype;

pro.listen = function(port) {
  //check status
  if(!!this.inited) {
    utils.invokeCallback(this.cb, new Error('already inited.'));
    return;
  }
  this.inited = true;

  var self = this;

  this.server = net.createServer();
  this.server.listen(port);

  this.server.on('error', function(err) {
    logger.error('rpc server is error: %j', err.stack);
    self.emit('error', err, this);
  });

  this.server.on('connection', function(socket) {
    socket.id = self.socketId++;
    self.sockets[socket.id] = socket;
    socket.composer = new Composer({maxLength: self.pkgSize});
    self.timer[socket.id] = null;
    self.heartbeat(socket.id);

    var handshakeBuf = [];
    var serverSupported = self.compression;
    var handshakeTimeout = setTimeout(function() {
      if (socket._handshakeDone) return;
      socket._handshakeDone = true;
      socket.removeListener('data', onData);
      finishServerHandshake(socket, self, null, Buffer.concat(handshakeBuf));
    }, handshake.HANDSHAKE_TIMEOUT_MS);

    var onData = function(data) {
      if (socket._handshakeDone) return;
      handshakeBuf.push(data);
      var buf = Buffer.concat(handshakeBuf);
      var parsed = handshake.parseClientHandshake(buf);
      if (parsed) {
        socket._handshakeDone = true;
        clearTimeout(handshakeTimeout);
        socket.removeListener('data', onData);
        var chosen = handshake.negotiateCompression(serverSupported, parsed.msg.compression);
        chosen = handshake.resolveCompression(chosen, parsed.msg.compression, compression.getCompressor);
        var response = handshake.serializeServerHandshake(chosen);
        socket.write(response);
        finishServerHandshake(socket, self, chosen, parsed.remainder);
        return;
      }
      if (buf.length > 0 && buf[0] !== 0x7B) {
        socket._handshakeDone = true;
        clearTimeout(handshakeTimeout);
        finishServerHandshake(socket, self, null, buf, onData);
      }
    };
    socket.on('data', onData);

    socket.on('error', function(err) {
      logger.error('[pomelo-rpc] tcp socket error: %j', err);
    });

    socket.on('close', function() {
      logger.info('[pomelo-rpc] tcp socket close: %s', socket.id);
      if (self.timer[socket.id]) {
        clearInterval(self.timer[socket.id]);
      }
      delete self.timer[socket.id];
      delete self.sockets[socket.id];
      delete self.msgQueues[socket.id];
    });
  });

  if(this.bufferMsg) {
    this._interval = setInterval(function() {
      flush(self);
    }, this.interval);
  }
};

function finishServerHandshake(socket, acceptor, chosenCompression, remainder, oldDataListener) {
  var compressor = chosenCompression && chosenCompression !== handshake.COMPRESSION_NONE
    ? compression.getCompressor(chosenCompression)
    : null;

  if (compressor) {
    socket._compressStream = compressor.createCompressStream();
    socket._decompressStream = compressor.createDecompressStream();
    socket._compressFlush = compressor.flush;
    socket._decompressStream.on('data', function(chunk) {
      socket.composer.feed(chunk);
    });
    socket._decompressStream.on('error', function(err) {
      logger.error('[pomelo-rpc] tcp acceptor decompress error: %j', err.message);
      socket.destroy();
    });
    socket._compressStream.on('data', function(chunk) {
      socket.write(chunk);
    });
    socket._writeRaw = function(buf) {
      socket._compressStream.write(buf);
      if (socket._compressFlush) socket._compressFlush(socket._compressStream);
    };
    socket.on('data', function(chunk) {
      socket._decompressStream.write(chunk);
    });
  } else {
    if (chosenCompression && chosenCompression !== handshake.COMPRESSION_NONE) {
      logger.warn('[pomelo-rpc] compression "%s" not available, using none (install optional dependency?)', chosenCompression);
    }
    socket._writeRaw = function(buf) {
      socket.write(buf);
    };
    socket.on('data', function(data) {
      socket.composer.feed(data);
    });
  }

  if (oldDataListener) {
    socket.removeListener('data', oldDataListener);
  }

  // Attach composer listener before feeding remainder so the first message(s) are not dropped.
  // Critical for legacy clients (handshake: false): remainder contains the first RPC frame.
  socket.composer.on('data', function(data) {
    acceptor.heartbeat(socket.id);
    if(data[0] === PING) {
      socket._writeRaw(socket.composer.compose(PONG));
    } else {
      try {
        var pkg = JSON.parse(data.toString('utf-8', 1));
        var id  = null;
        if(pkg instanceof Array) {
          processMsgs(socket, acceptor, pkg, id);
        } else {
          processMsg(socket, acceptor, pkg, id);
        }
      } catch(err) {
        if(err) {
          socket.composer.reset();
          logger.error(err);
        }
      }
    }
  });

  if (remainder && remainder.length > 0) {
    socket.composer.feed(remainder);
  }
}

/**
 * Send a new heartbeat over the connection to ensure that we're still
 * connected and our internet connection didn't drop. We cannot use server side
 * heartbeats for this unfortunately.
 *
 * @api private
 */
pro.heartbeat = function(socketId) {
  var self = this;
  if(!this.ping) return;

  if(this.timer[socketId]) {
    this.sockets[socketId].heartbeat = true;
    return;
  }

  this.timer[socketId] = setInterval(ping.bind(null, self, socketId), this.ping + 5000);
  logger.debug('[pomelo-rpc] wait ping with socket id: %s' ,socketId);
};

/**
 * Exterminate the connection as we've timed out.
 */
function ping(self, socketId) {
  if (!self.sockets[socketId]) {
    if (self.timer[socketId]) {
      clearInterval(self.timer[socketId]);
      delete self.timer[socketId];
    }
    return;
  }
  if (self.sockets[socketId].heartbeat) {
    self.sockets[socketId].heartbeat = false;
    return;
  }
  if (self.timer[socketId]) {
    clearInterval(self.timer[socketId]);
    delete self.timer[socketId];
  }
  self.sockets[socketId].composer.removeAllListeners();
  self.sockets[socketId].removeAllListeners();
  self.sockets[socketId].destroy();
  delete self.sockets[socketId];
  delete self.msgQueues[socketId];
  logger.debug('[pomelo-rpc] ping timeout with socket id: %s', socketId);
}

pro.close = function() {
  if(!!this.closed) {
    return;
  }
  this.closed = true;
  if(this._interval) {
    clearInterval(this._interval);
    this._interval = null;
  }
  try {
    this.server.close();
    // Server close stops receiving new connections, but does not kill existing connections
    // Below we stop open connections
    for (var socketId in this.sockets) {
      if (this.timer[socketId]) {
        clearInterval(this.timer[socketId]);
      }
      delete this.timer[socketId];
      if (this.sockets[socketId]) {
        this.sockets[socketId].end();
      }
      delete this.sockets[socketId];
      delete this.msgQueues[socketId];
    }
  } catch(err) {
    logger.error('[pomelo-rpc] rpc server close error: %j', err.stack);
  }
  this.emit('closed');
};

pro.preClose = function() {
  if (this.closed) {
    return
  }
  for (var socketId in this.sockets) {
    if (this.sockets[socketId]) {
      var socket = this.sockets[socketId];
      if (socket._writeRaw) {
        socket._writeRaw(socket.composer.compose(CLOSE_MSG));
      } else {
        socket.write(socket.composer.compose(CLOSE_MSG));
      }
    }
  }
}

var cloneError = function(origin) {
  // copy the stack infos for Error instance json result is empty
  var res = {
    message: origin.message,
    name: origin.name,
    stack: origin.stack
  };
  return res;
};

//need to redefine response
var processMsg = function(socket, acceptor, pkg, id) {
  var serverSpan = tracing.createServerSpan(pkg, pkg.msg.service + '::' + pkg.msg.method, {
    'peer.host': socket.remoteAddress,
    'peer.port': socket.remotePort
  });
  var tracer = new Tracer(acceptor.rpcLogger, acceptor.rpcDebugLog, pkg.remote, pkg.source, pkg.msg, pkg.traceId, pkg.seqId);
  tracer.info('server', __filename, 'processMsg', 'tcp-acceptor receive message and try to process message');
  var cb = acceptor.cb.bind(null, tracer, pkg.msg, function(err) {
    serverSpan.finish(err);
    var args = Array.prototype.slice.call(arguments, 0);
    for(var i=0, l=args.length; i<l; i++) {
      if(args[i] instanceof Error) {
        args[i] = cloneError(args[i]);
      }
    }
    var resp;
    if(tracer.isEnabled) {
      resp = {traceId: tracer.id, seqId: tracer.seq, source: tracer.source, id: pkg.id, resp: Array.prototype.slice.call(args, 0)};
    }
    else {
      resp = {id: pkg.id, resp: Array.prototype.slice.call(args, 0)};
    }
    if(acceptor.bufferMsg) {
      enqueue(socket, acceptor, resp);
    } else {
      socket._writeRaw(socket.composer.compose(RES_TYPE, JSON.stringify(resp), id));
    }
  });
  serverSpan.runInContext(function() {
    cb();
  });
};

var processMsgs = function(socket, acceptor, pkgs, id) {
  for(var i=0, l=pkgs.length; i<l; i++) {
    processMsg(socket, acceptor, pkgs[i], id);
  }
};

var enqueue = function(socket, acceptor, msg) {
  var queue = acceptor.msgQueues[socket.id];
  if(!queue) {
    queue = acceptor.msgQueues[socket.id] = [];
  }
  queue.push(msg);
};

//need modify
var flush = function(acceptor) {
  var sockets = acceptor.sockets, queues = acceptor.msgQueues, queue, socket;
  for(var socketId in queues) {
    socket = sockets[socketId];
    if(!socket) {
      // clear pending messages if the socket not exist any more
      delete queues[socketId];
      continue;
    }
    queue = queues[socketId];
    if(!queue.length) {
      continue;
    }
    if (socket._writeRaw) {
      socket._writeRaw(socket.composer.compose(RES_TYPE, JSON.stringify(queue), null));
    }
    queues[socketId] = [];
  }
};

/**
 * create acceptor
 *
 * @param opts init params
 * @param cb(tracer, msg, cb) callback function that would be invoked when new message arrives
 */
module.exports.create = function(opts, cb) {
  return new Acceptor(opts || {}, cb);
};
