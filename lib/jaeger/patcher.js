var eventContext = require('event-context');
var Module = require('module');

var wrap = function(object, method, patch) {
  var original = object[method];
  object[method] = Object.assign(patch(original), original);
};

var keepContext = function(original) {
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

var patches = {
  bluebird: function(object) {
    var methods = ['then', 'done', 'catch', 'caught', 'error', 'finally', 'lastly', 'asCallback', 'nodeify'];

    methods.forEach(function(method) {
      wrap(object.prototype, method, keepContext);
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
