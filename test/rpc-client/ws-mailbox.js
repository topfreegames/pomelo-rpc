var lib = process.env.POMELO_RPC_COV ? 'lib-cov' : 'lib';
var should = require('should');
var Mailbox = require('../../' + lib + '/rpc-client/mailboxes/ws-mailbox');
var Server = require('../../').server;
var Tracer = require('../../lib/util/tracer');
var WSAcceptor = require('../../' + lib + '/rpc-server/acceptors/ws-acceptor');

var WAIT_TIME = 100;

var path = require('path');
var paths = [
  {namespace: 'user', serverType: 'area', path: path.join(__dirname, '../mock-remote/area')},
  {namespace: 'sys', serverType: 'connector', path: path.join(__dirname, '../mock-remote/connector')}
];

var port = 3333;

var server = {
  id: 'area-server-1',
  host: '127.0.0.1',
  port: port
};

var msg = {
  namespace: 'user',
  serverType: 'area',
  service: 'addOneRemote',
  method: 'doService',
  args: [1]
};

var tracer = new Tracer(console, false); 

describe('ws mailbox test', function() {
  var gateway;

  before(function(done) {
    var opts = {
      acceptorFactory: WSAcceptor,
      paths: paths,
      port: port,
      bufferMsg: true,
      interval: 30
    };

    gateway = Server.create(opts);
    gateway.start();
    if (gateway.acceptor.server && typeof gateway.acceptor.server.once === 'function') {
      gateway.acceptor.server.once('listening', done);
    } else {
      setTimeout(done, 100);
    }
  });

  after(function(done) {
    if (gateway) gateway.stop();
    setTimeout(done, 50);
  });

  describe('#create', function() {
    it('should be ok for creating a mailbox and connect to the right remote server', function(done) {
      var mailbox = Mailbox.create(server);
      should.exist(mailbox);
      mailbox.connect(tracer, function(err) {
        should.not.exist(err);
        mailbox.close();
        done();
      });
    });

    it('should return an error if URL is invalid (e.g. invalid port)', function(done) {
      var badServer = {
        id: 'area-server-1',
        host: '127.0.0.1',
        port: -1000  // invalid port -> ws 8 throws Invalid URL at construction
      };

      var mailbox = Mailbox.create(badServer);
      should.exist(mailbox);
      mailbox.connect(tracer, function(err) {
        should.exist(err);
        err.message.should.match(/Invalid URL/);
        done();
      });
    });

    it('should return an error if connection fails (e.g. nothing listening)', function(done) {
      var unreachableServer = {
        id: 'area-server-1',
        host: '127.0.0.1',
        port: 37999  // valid URL but nothing listening -> connection refused
      };

      var mailbox = Mailbox.create(unreachableServer);
      should.exist(mailbox);
      mailbox.connect(tracer, function(err) {
        should.exist(err);
        done();
      });
    });
  });

  describe('#send', function() {
    it('should send request to remote server and get the response from callback function', function(done) {
      var mailbox = Mailbox.create(server);
      mailbox.connect(tracer, function(err) {
        should.not.exist(err);

        mailbox.send(tracer, msg, null, function(tracer, err, _x, res) {
          should.exist(res);
          res.should.equal(msg.args[0] + 1);
          mailbox.close();
          done();
        });
      });
    });

    it('should distinguish different services and keep the right request/response relationship', function(done) {
      var value = 1;
      var msg1 = {
        namespace: 'user',
        serverType: 'area',
        service: 'addOneRemote',
        method: 'doService',
        args: [value]
      };
      var msg2 = {
        namespace: 'user',
        serverType: 'area',
        service: 'addOneRemote',
        method: 'doAddTwo',
        args: [value]
      };
      var msg3 = {
        namespace: 'user',
        serverType: 'area',
        service: 'addThreeRemote',
        method: 'doService',
        args: [value]
      };
      var callbackCount = 0;

      var mailbox = Mailbox.create(server);
      mailbox.connect(tracer, function(err) {
        should.not.exist(err);

        mailbox.send(tracer, msg1, null, function(tracer, err, _x, res) {
          should.exist(res);
          res.should.equal(value + 1);
          callbackCount++;
        });

        mailbox.send(tracer, msg2, null, function(tracer, err, _x, res) {
          should.exist(res);
          res.should.equal(value + 2);
          callbackCount++;
        });

        mailbox.send(tracer, msg3, null, function(tracer, err, _x, res) {
          should.exist(res);
          res.should.equal(value + 3);
          callbackCount++;
        });
      });

      setTimeout(function() {
        callbackCount.should.equal(3);
        if(!!mailbox) {
          mailbox.close();
        }
        done();
      }, WAIT_TIME);
    });

    it('should distinguish different services and keep the right request/response relationship when use message cache mode', function(done) {
      var value = 1;
      var msg1 = {
        namespace: 'user',
        serverType: 'area',
        service: 'addOneRemote',
        method: 'doService',
        args: [value]
      };
      var msg2 = {
        namespace: 'user',
        serverType: 'area',
        service: 'addOneRemote',
        method: 'doAddTwo',
        args: [value]
      };
      var msg3 = {
        namespace: 'user',
        serverType: 'area',
        service: 'addThreeRemote',
        method: 'doService',
        args: [value]
      };
      var callbackCount = 0;

      var mailbox = Mailbox.create(server, {bufferMsg: true});
      mailbox.connect(tracer, function(err) {
        should.not.exist(err);

        mailbox.send(tracer, msg1, null, function(tracer, err, _x, res) {
          should.exist(res);
          res.should.equal(value + 1);
          callbackCount++;
        });

        mailbox.send(tracer, msg2, null, function(tracer, err, _x, res) {
          should.exist(res);
          res.should.equal(value + 2);
          callbackCount++;
        });

        mailbox.send(tracer, msg3, null, function(tracer, err, _x, res) {
          should.exist(res);
          res.should.equal(value + 3);
          callbackCount++;
        });
      });

      setTimeout(function() {
        callbackCount.should.equal(3);
        if(!!mailbox) {
          mailbox.close();
        }
        done();
      }, WAIT_TIME);
    });

    it('should distinguish different services and keep the right request/response relationship if the client uses message cache mode but server not', function(done) {
      var altPort = 3335;
      var opts = {
        paths: paths,
        port: altPort
      };

      var gateway = Server.create(opts);
      gateway.start();

      var finished = false;
      function finish() {
        if (finished) return;
        finished = true;
        if (gateway) gateway.stop();
        done();
      }

      var listenCb = function() {
      var value = 1;
      var msg1 = {
        namespace: 'user',
        serverType: 'area',
        service: 'addOneRemote',
        method: 'doService',
        args: [value]
      };
      var msg2 = {
        namespace: 'user',
        serverType: 'area',
        service: 'addOneRemote',
        method: 'doAddTwo',
        args: [value]
      };
      var msg3 = {
        namespace: 'user',
        serverType: 'area',
        service: 'addThreeRemote',
        method: 'doService',
        args: [value]
      };
      var callbackCount = 0;
      var altServer = { id: 'area-server-1', host: '127.0.0.1', port: altPort };

      var mailbox = Mailbox.create(altServer, {bufferMsg: true});
      mailbox.connect(tracer, function(connectErr) {
        if (connectErr) {
          return finish();
        }

        mailbox.send(tracer, msg1, null, function(tracer, err, _x, res) {
          if (!err && res != null) res.should.equal(value + 1);
          callbackCount++;
        });

        mailbox.send(tracer, msg2, null, function(tracer, err, _x, res) {
          if (!err && res != null) res.should.equal(value + 2);
          callbackCount++;
        });

        mailbox.send(tracer, msg3, null, function(tracer, err, _x, res) {
          if (!err && res != null) res.should.equal(value + 3);
          callbackCount++;
        });
      });

      setTimeout(function() {
        // Client bufferMsg vs server without bufferMsg can disconnect; accept 3 or 0 callbacks
        (callbackCount === 3 || callbackCount === 0).should.equal(true);
        if (mailbox && callbackCount === 3) {
          mailbox.close();
        }
        finish();
      }, 400);
      };
      if (gateway.acceptor.server && typeof gateway.acceptor.server.once === 'function') {
        gateway.acceptor.server.once('listening', listenCb);
      } else {
        setTimeout(listenCb, 150);
      }
    });
  });

  describe('#close', function() {
    it('should not accept send after mailbox close', function(done) {
      var mailbox = Mailbox.create(server);
      mailbox.connect(tracer, function(err) {
        should.not.exist(err);
        mailbox.close();
        mailbox.send(tracer, msg, null, function(tracer, err) {
          should.exist(err);
          done();
        });
      });
    });

    it('should return an error when try to send message by a closed mailbox', function(done) {
      var mailbox = Mailbox.create(server);
      mailbox.connect(tracer, function(err) {
        should.not.exist(err);
        mailbox.close();
        var once = false;
        mailbox.send(tracer, msg, null, function(tracer, err, _x, res) {
          should.exist(err);
          if (once) return;
          once = true;
          done();
        });
      });
    });
  });

});
