var EventEmitter = require('events').EventEmitter;
var util = require('util');
var utils = require('../../util/utils');
var Composer = require('../../util/composer');
var net = require('net');
var Tracer = require('../../util/tracer');
var handshake = require('../../util/tcp-handshake');
var compression = require('../../util/compression');
var logger = require('pomelo-logger').getLogger('pomelo-rpc', __filename);

var DEFAULT_CALLBACK_TIMEOUT = 10 * 1000;
var DEFAULT_INTERVAL = 50;
var MSG_TYPE = 0;
var PING = 1;
var PONG = 2;
var RES_TYPE = 3;
var CLOSE_MSG = 4;

var MailBox = function(server, opts) {
  EventEmitter.call(this);
  this.opts = opts || {};
  this.id = server.id;
  this.host = server.host;
  this.port = server.port;
  this.socket = null;
  this.composer = new Composer({maxLength: opts.pkgSize});
  this.requests = {};
  this.timeout = {};
  this.curId = 0;
  this.queue = [];
  this.bufferMsg = opts.bufferMsg;
  this.interval = opts.interval || DEFAULT_INTERVAL;
  this.timeoutValue = opts.timeout || DEFAULT_CALLBACK_TIMEOUT;

  // Heartbeat ping interval.
  this.ping = 'ping' in opts ? opts.ping : 5000;

  // Heartbeat pong response timeout.
  this.pong = 'pong' in opts ? opts.pong : 10000;

  this.timer = {};

  this.connected = false;
  this._writeRaw = null; // set after handshake: function(buf) to send to peer
  this._closed = false;
}
util.inherits(MailBox, EventEmitter);

var  pro = MailBox.prototype;

pro.connect = function(tracer, cb) {
  tracer.info('client', __filename, 'connect', 'tcp-mailbox try to connect');
  if(this.connected) {
    utils.invokeCallback(cb, new Error('mailbox has already connected.'));
    return;
  }
  this._closed = false;
  var self = this;
  this.socket = net.connect({port: this.port, host: this.host}, function(err) {
    if (err) {
      utils.invokeCallback(cb, err);
      return;
    }
    // Skip handshake when connecting to legacy servers (opts.handshake === false)
    if (self.opts.handshake === false) {
      finishHandshake(self, null, null, cb);
      return;
    }
    var clientHandshake = handshake.serializeClientHandshake({
      compression: self.opts.compression || [handshake.COMPRESSION_NONE, handshake.COMPRESSION_DEFLATE]
    });
    self.socket.write(clientHandshake);
    self._handshakeCb = cb;

    var handshakeBuf = [];
    var onData = function(data) {
      if (self._handshakeDone) return;
      handshakeBuf.push(data);
      var buf = Buffer.concat(handshakeBuf);
      var parsed = handshake.parseServerHandshake(buf);
      if (parsed) {
        self._handshakeDone = true;
        if (self._handshakeTimeout) { clearTimeout(self._handshakeTimeout); self._handshakeTimeout = null; }
        self.socket.removeListener('data', onData);
        finishHandshake(self, parsed.msg.compression, parsed.remainder, cb);
      }
    };
    self._handshakeTimeout = setTimeout(function() {
      if (self._handshakeDone) return;
      self._handshakeDone = true;
      self._handshakeTimeout = null;
      self.socket.removeListener('data', onData);
      finishHandshake(self, null, Buffer.concat(handshakeBuf), cb);
    }, handshake.HANDSHAKE_TIMEOUT_MS);
    self.socket.on('data', onData);
  });

  this.composer.on('data', function(data) {
    if(data[0] === PONG) {
      self.heartbeat();
    } else if (data[0] === CLOSE_MSG) {
      self.closing = true;
      self.emit('closing', self.id);
    } else {
      try {
        var pkg = JSON.parse(data.toString('utf-8', 1));
        if(pkg instanceof Array) {
          processMsgs(self, pkg);
        } else {
          processMsg(self, pkg);
        }
      } catch(err) {
        if(err) {
          logger.error('[pomelo-rpc] tcp mailbox process data error: %j', err.stack);
        }
      }
    }
  });

  this.socket.on('error', function(err) {
    if (self._handshakeTimeout) { clearTimeout(self._handshakeTimeout); self._handshakeTimeout = null; }
    if(!self.connected) {
      if (typeof self._handshakeCb === 'function') {
        self._handshakeCb(err);
        self._handshakeCb = null;
      }
      return;
    }
    self.emit('close', self.id);
    self.close();
  });

  this.socket.on('close', function() {
    if (self._handshakeTimeout) { clearTimeout(self._handshakeTimeout); self._handshakeTimeout = null; }
    self.emit('close', self.id);
    self.close();
  });

  this.socket.on('end', function() {
    if (self._handshakeTimeout) { clearTimeout(self._handshakeTimeout); self._handshakeTimeout = null; }
    self.emit('close', self.id);
    self.close();
  });
};

function finishHandshake(mailbox, chosenCompression, remainder, cb) {
  var socket = mailbox.socket;
  var compressor = chosenCompression && chosenCompression !== handshake.COMPRESSION_NONE
    ? compression.getCompressor(chosenCompression)
    : null;

  if (compressor) {
    mailbox._compressStream = compressor.createCompressStream();
    mailbox._decompressStream = compressor.createDecompressStream();
    mailbox._compressFlush = compressor.flush;
    mailbox._decompressStream.on('data', function(chunk) {
      mailbox.composer.feed(chunk);
    });
    mailbox._decompressStream.on('error', function(err) {
      logger.error('[pomelo-rpc] tcp mailbox decompress error: %j', err.message);
      mailbox.emit('close', mailbox.id);
      mailbox.close();
    });
    mailbox._compressStream.on('data', function(chunk) {
      socket.write(chunk);
    });
    mailbox._writeRaw = function(buf) {
      mailbox._compressStream.write(buf);
      if (mailbox._compressFlush) mailbox._compressFlush(mailbox._compressStream);
    };
    socket.on('data', function(chunk) {
      mailbox._decompressStream.write(chunk);
    });
  } else {
    if (chosenCompression && chosenCompression !== handshake.COMPRESSION_NONE) {
      logger.warn('[pomelo-rpc] compression "%s" not available, using none (install optional dependency?)', chosenCompression);
    }
    mailbox._writeRaw = function(buf) {
      socket.write(buf);
    };
    socket.on('data', function(chunk) {
      mailbox.composer.feed(chunk);
    });
  }

  if (remainder && remainder.length > 0) {
    // When compression is used, remainder is compressed; feed it through decompress stream.
    if (mailbox._decompressStream) {
      mailbox._decompressStream.write(remainder);
    } else {
      mailbox.composer.feed(remainder);
    }
  }

  mailbox.connected = true;
  if (mailbox.bufferMsg) {
    mailbox._interval = setInterval(function() {
      flush(mailbox);
    }, mailbox.interval);
  }
  mailbox.heartbeat();
  if (typeof cb === 'function') {
    cb(null);
  }
}

/**
 * close mailbox :: clear timer and close socket
 */
 pro.close = function() {
  if (this._closed) return;
  this._closed = true;
  this.connected = false;
  if (this._handshakeTimeout) { clearTimeout(this._handshakeTimeout); this._handshakeTimeout = null; }
  if(this._interval) {
    clearInterval(this._interval);
    this._interval = null;
  }
  if(this.timer){
    clearTimeout(this.timer['ping']);
    this.timer['ping'] = null;
    clearTimeout(this.timer['pong']);
    this.timer['pong'] = null;
  }

  //clear cb timer
  for(var id in this.timeout) {
    clearCbTimeout(this, id);
  }

  if (this.socket) {
    if (this._compressStream && typeof this._compressStream.destroy === 'function') this._compressStream.destroy();
    if (this._decompressStream && typeof this._decompressStream.destroy === 'function') this._decompressStream.destroy();
    this.socket.removeAllListeners();
    this.composer.removeAllListeners();
    this.socket.destroy();
    this.socket = null;
  }
};

/**
 * send message to remote server
 *
 * @param msg {service:"", method:"", args:[]}
 * @param opts {} attach info to send method
 * @param cb declaration decided by remote interface
 */
 pro.send = function(tracer, msg, opts, cb) {
  tracer.info('client', __filename, 'send', 'tcp-mailbox try to send');
  if(!this.connected) {
    utils.invokeCallback(cb, tracer, new Error('not init.'));
    return;
  }

  var id = this.curId++ & 0xffffffff;
  this.requests[id] = cb;
  setCbTimeout(this, id, tracer, cb);
  var pkg;

  if(tracer.isEnabled) {
    pkg = {traceId: tracer.id, seqId: tracer.seq, source: tracer.source, remote: tracer.remote, id: id, msg: msg};
  }
  else {
    pkg = {id: id, msg: msg};
  }

  if (tracer.span && tracer.span.inject && !tracer.span.isNoop) {
    tracer.span.inject(pkg);
    tracer.span.addTags({
      'peer.host': this.socket.remoteAddress,
      'peer.port': this.socket.remotePort
    });
  }

  if(this.bufferMsg) {
    enqueue(this, pkg);
  } else {
    this._writeRaw(this.composer.compose(MSG_TYPE, JSON.stringify(pkg), id));
  }
};

/**
 * Send a new heartbeat over the connection to ensure that we're still
 * connected and our internet connection didn't drop. We cannot use server side
 * heartbeats for this unfortunately.
 *
 * @api private
 */
 pro.heartbeat = function() {
  var self = this;
  if(!this.ping) return;

  if(this.timer['pong']) {
    clearTimeout(this.timer['pong']);
    this.timer['pong'] = null;
  }

  if(!this.timer['ping']) {
    this.timer['ping'] = setTimeout(ping, this.ping);
  }

  /**
   * Exterminate the connection as we've timed out.
   *
   * @api private
   */
  function pong() {
    if(self.timer['pong']) {
      clearTimeout(self.timer['pong']);
      self.timer['pong'] = null;
    }
    self.emit('close', self.id);
    logger.warn('pong timeout');
    self.close();
  }

  /**
   * We should send a ping message to the server.
   *
   * @api private
   */
  function ping() {
    if(self.timer['ping']) {
      clearTimeout(self.timer['ping']);
      self.timer['ping'] = null;
    }
    self._writeRaw(self.composer.compose(PING));
    self.timer['pong'] = setTimeout(pong, self.pong);
  }
};

var enqueue = function(mailbox, msg) {
  mailbox.queue.push(msg);
};

var flush = function(mailbox) {
  if(!mailbox || !mailbox.queue.length || !mailbox._writeRaw) {
    return;
  }
  mailbox._writeRaw(mailbox.composer.compose(MSG_TYPE, JSON.stringify(mailbox.queue), mailbox.queue[0].id));
  mailbox.queue = [];
};

var processMsgs = function(mailbox, pkgs) {
  for(var i=0, l=pkgs.length; i<l; i++) {
    processMsg(mailbox, pkgs[i]);
  }
};

var processMsg = function(mailbox, pkg) {
  clearCbTimeout(mailbox, pkg.id);
  var cb = mailbox.requests[pkg.id];
  if(!cb) {
    return;
  }
  delete mailbox.requests[pkg.id];

  var tracer = new Tracer(mailbox.opts.rpcLogger, mailbox.opts.rpcDebugLog, mailbox.opts.clientId, pkg.source, pkg.resp, pkg.traceId, pkg.seqId);
  var args = [tracer, null];

  pkg.resp.forEach(function(arg){
    args.push(arg);
  });

  cb.apply(null, args);
};

var setCbTimeout = function(mailbox, id, tracer, cb) {
  var timer = setTimeout(function() {
    clearCbTimeout(mailbox, id);
    if(!!mailbox.requests[id]) {
      delete mailbox.requests[id];
    }
    logger.error('[pomelo-rpc] rpc callback timeout, remote server host: %s, port: %s', mailbox.host, mailbox.port);
    mailbox.emit('close', mailbox.id);
    utils.invokeCallback(cb, tracer, new Error('rpc callback timeout'));
  }, mailbox.timeoutValue);
  mailbox.timeout[id] = timer;
};

var clearCbTimeout = function(mailbox, id) {
  if(!mailbox.timeout[id]) {
    logger.warn('[pomelo-rpc] timer not exists, id: %s', id);
    return;
  }
  clearTimeout(mailbox.timeout[id]);
  delete mailbox.timeout[id];
};

/**
 * Factory method to create mailbox
 *
 * @param {Object} server remote server info {id:"", host:"", port:""}
 * @param {Object} opts construct parameters
 *                      opts.bufferMsg {Boolean} msg should be buffered or send immediately.
 *                      opts.interval {Boolean} msg queue flush interval if bufferMsg is true. default is 50 ms
 */
 module.exports.create = function(server, opts) {
  return new MailBox(server, opts || {});
};
