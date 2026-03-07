var lib = process.env.POMELO_RPC_COV ? 'lib-cov' : 'lib';
var MailStation = require('../../' + lib + '/rpc-client/mailstation');
var should = require('should');
var Server = require('../../').server;
var Tracer = require('../../lib/util/tracer');

var WAIT_TIME = 500;

// proxy records
var path = require('path');
var records = [
  {namespace: 'user', serverType: 'area', path: path.join(__dirname, '../mock-remote/area')},
  {namespace: 'sys', serverType: 'connector', path: path.join(__dirname, '../mock-remote/connector')}
];

// server info list (serverType required by replaceServers) - use different ports than client test to avoid EADDRINUSE
var serverList = [
  {id: 'area-server-1', serverType: 'area', host: '127.0.0.1', port: 3336},
  {id: 'connector-server-1', serverType: 'connector', host: '127.0.0.1', port: 4446},
  {id: 'connector-server-2', serverType: 'connector', host: '127.0.0.1', port: 5556},
];

// rpc description message
var msg = {
  namespace: 'user',
  serverType: 'area',
  service: 'whoAmIRemote',
  method: 'doService',
  args: []
};

describe('mail station', function() {
  var gateways = [];

  before(function(done) {
    gateways = [];
    var item, opts, gateway;
    for (var i = 0, l = serverList.length; i < l; i++) {
      item = serverList[i];
      opts = {
        paths: records,
        port: item.port,
        context: {id: item.id}
      };
      gateway = Server.create(opts);
      gateways.push(gateway);
      gateway.start();
    }
    var pending = serverList.length;
    function onListening() {
      if (--pending === 0) done();
    }
    for (var j = 0; j < gateways.length; j++) {
      gateways[j].acceptor.server.once('listening', onListening);
    }
  });

  after(function(done) {
    //stop remote servers
    for(var i=0; i<gateways.length; i++) {
      gateways[i].stop();
    }
    done();
  });

  describe('#create', function() {
    it('should be ok for pass an empty opts to the factory method', function(done) {
      var station = MailStation.create();
      should.exist(station);

      station.start(function(err) {
        should.not.exist(err);
        station.stop();
        done();
      });

      station.should.have.property('mailboxFactory');
    });

    it('should change the default mailbox by pass the mailboxFactory to the create function', function() {
      var mailboxFactory = {
        create: function(opts, cb) {
          return null;
        }
      };

      var opts = {
        mailboxFactory: mailboxFactory
      };

      var station = MailStation.create(opts);
      should.exist(station);

      station.should.have.property('mailboxFactory');
      station.mailboxFactory.should.equal(mailboxFactory);
    });
  });

  describe('#replaceServers', function() {
    it('should add the server info into the mail station', function() {
      var station = MailStation.create();
      should.exist(station);

      station.replaceServers(serverList);

      var servers = station.servers, item, server;
      for (var i = 0, l = serverList.length; i < l; i++) {
        item = serverList[i];
        server = servers[item.id];
        should.exist(server);
        server.id.should.equal(item.id);
        server.host.should.equal(item.host);
        server.port.should.equal(item.port);
      }
    });
  });

  describe('#dispatch', function() {
    it('should send request to the right remote server and get the response from callback function', function(done) {
      var callbackCount = 0;
      var count = 0;
      var station = MailStation.create();
      should.exist(station);

      station.replaceServers(serverList);

      var func = function(id) {
        return function(err, remoteId) {
          should.exist(remoteId);
          remoteId.should.equal(id);
          callbackCount++;
        };
      };
      var tracer = new Tracer(null, false); 

      station.start(function(err) {
        var item;
        for(var i=0, l=serverList.length; i<l; i++) {
          count++;
          item = serverList[i];
          station.dispatch(tracer, item.id, msg, null, func(item.id));
        }
      });
      setTimeout(function() {
        callbackCount.should.equal(count);
        station.stop();
        done();
      }, WAIT_TIME);
    });

    it('should send request to the right remote server and get the response from callback function', function(done) {
      var callbackCount = 0;
      var count = 0;
      var station = MailStation.create();
      should.exist(station);

      station.replaceServers(serverList);

      var func = function(id) {
        return function(err, remoteId) {
          should.exist(remoteId);
          remoteId.should.equal(id);
          callbackCount++;
        };
      };

      var tracer = new Tracer(null, false); 

      station.start(function(err) {
        var item;
        for(var i=0, l=serverList.length; i<l; i++) {
          count++;
          item = serverList[i];
          station.dispatch(tracer, item.id, msg, null, func(item.id));
        }
      });
      setTimeout(function() {
        callbackCount.should.equal(count);
        station.stop();
        done();
      }, WAIT_TIME);
    });

    it('should update the mailbox map by add server after start', function(done) {
      var callbackCount = 0;
      var station = MailStation.create();
      should.exist(station);

      station.replaceServers(serverList);

      var tracer = new Tracer(null, false); 

      station.start(function(err) {
        var item = serverList[0];
        station.replaceServers(serverList);
        station.dispatch(tracer, item.id, msg, null, function(err, remoteId) {
          should.exist(remoteId);
          remoteId.should.equal(item.id);
          callbackCount++;
        });
      });
      setTimeout(function() {
        callbackCount.should.equal(1);
        station.stop();
        done();
      }, WAIT_TIME);
    });

    it('should not crash when dispatching to an invalid server in lazy connect mode', function(done) {
      var serverId = 'invalid-server-id';
      var server = {id: serverId, serverType: 'invalid-server', host: 'localhost', port: 1234};
      var station = MailStation.create();
      should.exist(station);

      station.replaceServers([server]);
      station.on('error', function() {});

      var tracer = new Tracer(null, false);

      station.start(function(err) {
        should.exist(station);
        station.dispatch(tracer, serverId, msg, null, function() {});
      });
      setTimeout(function() {
        station.stop();
        done();
      }, WAIT_TIME);
    });
  });

  describe('#close', function() {
    it('should close all mailboxes on station stop', function(done) {
      var errorEmitCount = 0;
      var station = MailStation.create();
      should.exist(station);

      station.replaceServers(serverList);
      station.on('error', function() {
        errorEmitCount++;
      });

      var tracer = new Tracer(null, false);

      station.start(function(err) {
        var item;
        for (var i = 0, l = serverList.length; i < l; i++) {
          item = serverList[i];
          station.dispatch(tracer, item.id, msg, null, function() {});
        }
      });

      setTimeout(function() {
        station.stop(true);
        setTimeout(function() {
          for (var j = 0, len = serverList.length; j < len; j++) {
            station.dispatch(tracer, serverList[j].id, msg, null, function() {});
          }
          setTimeout(function() {
            errorEmitCount.should.equal(serverList.length);
            done();
          }, WAIT_TIME);
        }, 50);
      }, WAIT_TIME);
    });

    it('should return an error when try to dispatch message by a closed station', function(done) {
      var errorEmitCount = 0;
      var i, l;

      var station = MailStation.create();
      should.exist(station);

      station.replaceServers(serverList);

      station.on('error', function() {
        errorEmitCount++;
      });

      var tracer = new Tracer(null, false);

      station.start(function(err) {
        station.stop();
        var item;
        for(i=0, l=serverList.length; i<l; i++) {
          item = serverList[i];
          station.dispatch(tracer, item.id, msg, null, function() {});
        }
      });
      setTimeout(function() {
        errorEmitCount.should.equal(serverList.length);
        done();
      }, WAIT_TIME);
    });
  });

  describe('#filters', function() {
    it('should invoke filters in turn', function(done) {
      var preFilterCount = 0;
      var afterFilterCount = 0;
      var sid = 'connector-server-1';
      var orgMsg = msg;
      var orgOpts = {something: 'hello'};
      var station = MailStation.create();
      should.exist(station);

      station.replaceServers(serverList);

      var tracer = new Tracer(null, false); 

      station.start(function(err) {
        station.before(function(fsid, fmsg, fopts, next) {
          preFilterCount.should.equal(0);
          afterFilterCount.should.equal(0);
          fsid.should.equal(sid);
          fmsg.should.equal(msg);
          fopts.should.equal(orgOpts);
          preFilterCount++;
          next(fsid, fmsg, fopts);
        });

        station.before(function(fsid, fmsg, fopts, next) {
          preFilterCount.should.equal(1);
          afterFilterCount.should.equal(0);
          fsid.should.equal(sid);
          fmsg.should.equal(msg);
          fopts.should.equal(orgOpts);
          preFilterCount++;
          next(fsid, fmsg, fopts);
        });

        station.after(function(fsid, fmsg, fopts, next) {
          preFilterCount.should.equal(2);
          afterFilterCount.should.equal(0);
          fsid.should.equal(sid);
          fmsg.should.equal(msg);
          fopts.should.equal(orgOpts);
          afterFilterCount++;
          next(fsid, fmsg, fopts);
        });

        station.after(function(fsid, fmsg, fopts, next) {
          preFilterCount.should.equal(2);
          afterFilterCount.should.equal(1);
          fsid.should.equal(sid);
          fmsg.should.equal(msg);
          fopts.should.equal(orgOpts);
          afterFilterCount++;
          next(fsid, fmsg, fopts);
        });

        station.dispatch(tracer, sid, orgMsg, orgOpts, function() {});
      });

      var once = false;
      setTimeout(function() {
        preFilterCount.should.equal(2);
        afterFilterCount.should.equal(2);
        station.stop();
        if (once) return;
        once = true;
        done();
      }, WAIT_TIME);
    });
  });
});
