var eventContext = require('tfg-event-context');
var Module = require('module');
var tracer = require('./tracer');

var wrap = function(object, method, patch) {
  var original = object[method];
  object[method] = Object.assign(patch(original), original);
};

var patches = {
  bluebird: function(object) {
    var methods = ['then', 'done', 'catch', 'caught', 'error', 'finally', 'lastly', 'asCallback', 'nodeify'];

    var patch = function(original) {
      return function() {
        var context = eventContext.getCurrentContext();

        if(!context) {
          return original.apply(this, arguments);
        }

        var args = Array.prototype.slice.call(arguments).map(function(arg) {
          if(typeof arg !== 'function') {
            return arg;
          }
          return function() {
            eventContext.setCurrentContext(context);
            try {
              return arg.apply(this, arguments);
            }
            finally {
              eventContext.revertContext();
            }
          };
        });

        return original.apply(this, args);
      };
    };

    methods.forEach(function(method) {
      wrap(object.prototype, method, patch);
    });
  },

  http: function(object) {
    wrap(object, 'request', function(original) {
      return function(options, cb) {
        var request = original.call(this, options, function(response) {
          span.setTag('http.status_code', response.statusCode);

          response.on('end', function() {
            span.finish();
          });

          if(cb) {
            return cb.call(this, response);
          }
        });

        request.on('error', function(err) {
          span.finish(err);
        });

        var parent = tracer.currentSpan();
        var span = parent.startSpan(`send ${request.method} ${request.path}`, {
          'http.method': request.method,
          'http.url': request.getHeader('host') + request.path
        });

        return request;
      };
    });

    wrap(object, 'createServer', function(original) {
      return function(requestListener) {
        var wrapped = function(request, response) {
          var span = tracer.startSpan(request.headers, `receive ${request.method} ${request.url}`, {
            'http.method': request.method,
            'http.url': request.url
          });

          response.on('finish', function() {
            span.setTag('http.status_code', response.statusCode);
            span.finish();
          });

          return span.propagate(function() {
            return requestListener.call(this, request, response);
          });
        };
        return original.call(this, wrapped);
      };
    });
  }
};

wrap(Module, '_load', function(load) {
  return function(file) {
    var object = load.apply(this, arguments);
    var patch = patches[file];

    if(patch && !object.__patched) {
      patch(object);
      object.__patched = true;
    }

    return object;
  };
});

wrap(process, 'nextTick', function(nextTick) {
  return function(callback) {
    var context = eventContext.getCurrentContext();

    if(!context) {
      return nextTick.apply(this, arguments);
    }

    var computation = function() {
      eventContext.setCurrentContext(context);
      try {
        return callback.apply(this, arguments);
      }
      finally {
        eventContext.revertContext();
      }
    };

    var args = Array.prototype.slice.call(arguments, 1);
    args = [computation].concat(args);

    return nextTick.apply(this, args);
  };
});

wrap(global, 'setImmediate', function(setImmediate) {
  return function(callback) {
    var context = eventContext.getCurrentContext();

    if(!context) {
      return setImmediate.apply(this, arguments);
    }

    var computation = function() {
      eventContext.setCurrentContext(context);
      try {
        return callback.apply(this, arguments);
      }
      finally {
        eventContext.revertContext();
      }
    };

    var args = Array.prototype.slice.call(arguments, 1);
    args = [computation].concat(args);

    var id = setImmediate.apply(this, args);
    var dispose = clearImmediate.bind(null, id);
    context.addDisposable(dispose);
    return id;
  };
});
