var eventContext = require('event-context');
var eventContextPluginNode = require('event-context-plugin-node');

eventContextPluginNode.patch();

var methods = ['_then', 'catch', 'caugth', 'finally', 'lastly'];
var natives = {};

module.exports.patch = function(bluebird) {
  methods.forEach(function(method) {
    natives[method] = bluebird.prototype[method];

    bluebird.prototype[method] = function() {
      var currentContext = eventContext.getCurrentContext();
      var params = Array.prototype.slice.call(arguments);

      if(!currentContext) {
        return natives[method].apply(this, params);
      }

      var wrappedParams = params.map(function(f) {
        if(typeof f !== 'function') {
          return f;
        }

        return function() {
          eventContext.setCurrentContext(currentContext);
          var ret = f.apply(this, arguments);
          eventContext.revertContext();
          return ret;
        };
      });

      return natives[method].apply(this, wrappedParams);
    };
  });

  return function() {
    methods.forEach(function(method) {
      bluebird[method] = natives[method];
    });
  };
};
