var net = require('net');
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var utils = require('../../../lib/util/utils');
var Composer = require('../../../lib/util/composer');
var handshake = require('../../../lib/util/tcp-handshake');

var MSG_TYPE = 0;
var RES_TYPE = 3;

var Client = function() {
  EventEmitter.call(this);
  this.requests = {};
  this.curId = 0;
  this.composer = new Composer();
  this.socket = null;
  this._writeRaw = null;
};
util.inherits(Client, EventEmitter);

var pro = Client.prototype;

pro.connect = function(host, port, cb) {
  var self = this;
  var socket;
  try {
    socket = net.connect({ port: port, host: host });
  } catch (err) {
    utils.invokeCallback(cb, err);
    return;
  }
  this.socket = socket;

  socket.on('connect', function() {
    var clientHandshake = handshake.serializeClientHandshake({
      compression: [handshake.COMPRESSION_NONE, handshake.COMPRESSION_DEFLATE]
    });
    socket.write(clientHandshake);

    var handshakeBuf = [];
    var onData = function(data) {
      handshakeBuf.push(data);
      var buf = Buffer.concat(handshakeBuf);
      var parsed = handshake.parseServerHandshake(buf);
      if (parsed) {
        socket.removeListener('data', onData);
        self._writeRaw = function(buf) { socket.write(buf); };
        if (parsed.remainder && parsed.remainder.length) {
          self.composer.feed(parsed.remainder);
        }
        socket.on('data', function(data) {
          self.composer.feed(data);
        });
        utils.invokeCallback(cb);
      }
    };
    socket.on('data', onData);
  });

  socket.on('error', function(err) {
    if (!self._writeRaw) utils.invokeCallback(cb, err);
  });

  this.composer.on('data', function(data) {
    if (data[0] === RES_TYPE) {
      var pkg = JSON.parse(data.toString('utf8', 1));
      var reqCb = self.requests[pkg.id];
      delete self.requests[pkg.id];
      if (reqCb) reqCb.apply(null, pkg.resp);
    }
  });
};

pro.send = function(msg, cb) {
  var id = this.curId++;
  this.requests[id] = cb;
  this._writeRaw(this.composer.compose(MSG_TYPE, JSON.stringify({ id: id, msg: msg }), id));
};

pro.close = function() {
  if (this.socket) this.socket.end();
};

module.exports.create = function(opts) {
  return new Client();
};
