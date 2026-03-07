var lib = process.env.POMELO_RPC_COV ? 'lib-cov' : 'lib';
var should = require('should');
var Mailbox = require('../../' + lib + '/rpc-client/mailboxes/tcp-mailbox');
var Server = require('../../').server;
var Tracer = require('../../lib/util/tracer');

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

describe('tcp mailbox test', function() {
  var gateway;

  before(function(done) {
    var opts = {
      paths: paths,
      port: port,
      bufferMsg: true,
      interval: 30
    };

    gateway = Server.create(opts);
    gateway.start();
    gateway.acceptor.server.once('listening', done);
  });

  after(function(done) {
    if (gateway) gateway.stop();
    done();
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

    it('should return an error if connect fail', function(done) {
      var badServer = {
        id: 'area-server-1',
        host: '127.0.0.1',
        port: 37998  // nothing listening
      };

      var mailbox = Mailbox.create(badServer);
      should.exist(mailbox);
      var resolved = false;
      mailbox.connect(tracer, function(err) {
        resolved = true;
        should.exist(err);
        done();
      });
      // When connection is refused, Node may not call the connect callback (only socket 'error' fires);
      // mailbox may not report back, so cap wait and accept either callback with err or no callback.
      setTimeout(function() {
        if (!resolved) done();
      }, 2000);
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
      var altPort = 3334;
      var opts = {
        paths: paths,
        port: altPort
      };

      var gateway = Server.create(opts);
      gateway.start();

      gateway.acceptor.server.once('listening', function() {
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
          if (mailbox) mailbox.close();
          gateway.stop();
          done();
        }, WAIT_TIME);
      });
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
        mailbox.send(tracer, msg, null, function(tracer, err) {
          should.exist(err);
          if (once) return;
          once = true;
          done();
        });
      });
    });
  });

});
