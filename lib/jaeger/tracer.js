var eventContext = require('event-context');
var jaeger = require('jaeger-client');
var Span = require('./span');

var factory = function(opts) {
  if(typeof opts.probability !== 'number' && !opts.disable) {
    throw Error('Expected opts.probability to be a number, got ' + typeof opts.probability + '.');
  }

  var config = {
  	serviceName: opts.serviceName,
    disable: opts.disable,
  	sampler: {
      type: 'probabilistic',
      param: opts.probability
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

  return jaeger.initTracer(config, options);
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
  } catch(err) {}

  opts = opts || {};
  instance = factory(opts);
};

var instance = null;
var defaults = {
  disable: true
};

module.exports.configure(defaults);
