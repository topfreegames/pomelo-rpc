var eventContext = require('event-context');
var logger = require('pomelo-logger').getLogger('pomelo-rpc', __filename);

var verifyContext = function(context) {
  var count = 1;
  while(context.parent) {
    count += 1;
    context = context.parent;
  }
  if(count > 1) {
    logger.error('Number of running contexts:', count);
  }
};

var Span = function(tracer, parent, operationName, tags) {
  this._tracer = tracer;
  this._span = tracer.startSpan(operationName, {
    childOf: parent,
    tags: tags,
  });
};

Span.prototype.startSpan = function(operationName, tags) {
  return new Span(this._tracer, this._span, operationName, tags);
};

Span.prototype.propagate = function(cb) {
  var ctx = eventContext.createContext();
  var state = ctx.getState();

  state.span = this;
  ctx.run(function() {
    verifyContext(ctx);
    cb()
  });
};

Span.prototype.inject = function(carrier) {
  this._tracer.inject(this._span, 'text_map', carrier);
};

Span.prototype.addTags = function(tags) {
  this._span.addTags(tags);
};

Span.prototype.finish = function(err) {
  if(err instanceof Error) {
    this._span.setTag('error', true);
    this._span.log({
      'event': 'error',
      'message': err.message,
      'stack': err.stack,
      'error.kind': err.name
    });
  }
  this._span.finish();
};

Span.mock = function(tracer) {
  return {
    startSpan: function(operationName, tags) {
      if(tracer) {
        return new Span(tracer, null, operationName, tags);
      }
      return Span.mock();
    },
    propagate: function(cb) {
      cb();
    },
    inject: function(carrier) {},
    addTags: function(tags) {},
    finish: function(err) {}
  };
}

module.exports = Span;
