require('./lib/util/event-context-patcher');

if(process.env.POMELO_RPC_COV) {
  module.exports.client = require('./lib-cov/rpc-client/client');
  module.exports.server = require('./lib-cov/rpc-server/server');
  module.exports.tracer = require('./lib-cov/jaeger/tracer');
} else {
  module.exports.client = require('./lib/rpc-client/client');
  module.exports.server = require('./lib/rpc-server/server');
  module.exports.tracer = require('./lib/jaeger/tracer');
}
