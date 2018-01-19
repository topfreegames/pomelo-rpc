var eventContext = require('event-context');
var eventContextPatcher = require('../util/event-context-patcher');
var jaeger = require('jaeger-client');
var Span = require('./span');

var factory = function(opts) {
  var unpatch;
  if(opts.bluebird) {
    unpatch =  eventContextPatcher.patch(opts.bluebird);
  }

  var config = {
  	serviceName: opts.serviceName,
    disable: opts.disable,
  	sampler: {
      type: 'probabilistic',
      param: opts.probability
    },
    reporter: {
      agentHost: opts.host,
      agentPort: opts.port
    }
  };

  var options = {
    tags: {
      'game.name': opts.game
    }
  };

  if(opts.version) {
    options.tags['game.version'] = opts.version;
  }

  var tracer = jaeger.initTracer(config, options);
  tracer.unpatch = unpatch;
  return tracer;
};

module.exports.currentSpan = function() {
  var ctx = eventContext.getCurrentContext();
  return ctx? ctx.getState().span : null;
};

module.exports.startSpan = function(carrier, operationName, tags) {
  var parent = instance.extract('text_map', carrier);
  return new Span(instance, parent, operationName, tags);
};

module.exports.configure = function(opts) {
  try {
    instance.close();
    instance.unpatch();
  } catch(err) {}

  opts = opts || {};
  instance = factory(opts);
};

var instance = null;
var defaults = {
  disable: true
};

module.exports.configure(defaults);
