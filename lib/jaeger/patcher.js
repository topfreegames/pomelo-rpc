var eventContext = require('tfg-event-context');
var Module = require('module');
var tracer = require('./tracer');
var url = require('url');

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

    wrap(object.prototype, '_resolveFromExecutor', function(original) {
      return function(executor) {
        original.call(this, patch(executor))
      };
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
        var span = parent.startSpan(request.method + ' ' + url.parse(request.path).pathname, {
          'http.method': request.method,
          'http.url': request.getHeader('host') + request.path,
          'span.kind': 'client'
        });

        return request;
      };
    });

    wrap(object, 'createServer', function(original) {
      return function(requestListener) {
        var wrapped = function(request, response) {
          var span = tracer.startSpan(request.headers, request.method + ' ' + url.parse(request.url).pathname, {
            'http.method': request.method,
            'http.url': request.headers.host + request.url,
            'span.kind': 'server'
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
  },

  sequelize: function(object) {
    wrap(object.Sequelize.prototype, 'query', function(original) {
      return function(sql, options) {
        var parent = tracer.currentSpan();
        var span = parent.startSpan('SQL ' + options.type, {
          'db.instance': this.config.database,
          'db.statement': sql,
          'db.type': 'sql',
          'db.user': this.config.username,
          'span.kind': 'client'
        });

        return original.call(this, sql, options)
          .then(
            function(result) {
              span.finish();
              return result;
            },
            function(err) {
              span.finish(err);
              throw err;
            }
          );
      };
    });
  },

  ioredis: function(object) {
    wrap(object.prototype, 'sendCommand', function(original) {
      return function(command, stream) {
        var parent = tracer.currentSpan();
        var span = parent.startSpan('redis ' + command.name, {
          'db.instance': this.options.db,
          'db.statement': command.name + ' ' + command.args.join(' '),
          'db.type': 'redis',
          'span.kind': 'client'
        });

        return original.apply(this, arguments)
          .then(
            function(value) {
              span.finish();
              return value;
            },
            function(err) {
              span.finish(err);
              throw err;
            }
          );
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
