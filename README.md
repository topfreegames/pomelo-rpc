#pomelo-rpc - rpc framework for pomelo

pomelo-rpc is the low level RPC framework for pomelo project. It contains two parts: client and server.

The client part generates the RPC client proxy, routes the message to the appropriate remote server and manages the network communications. Support add proxies and remote server information dynamically.

The server part exports the remote services, dispatches the remote requests to the services and also manages the network communications.

And the remote service codes would loaded by pomelo-loader module and more details please access this [link](https://github.com/node-pomelo/pomelo-loader).

+ Tags: node.js

##Installation
```
npm install pomelo-rpc
```

##Usage
###Server
``` javascript
var Server = require('pomelo-rpc').server;

// remote service path info list
var paths = [
  {namespace: 'user', path: __dirname + '/remote/test'}
];

var port = 3333;

var server = Server.create({paths: paths, port: port});
server.start();
console.log('rpc server started.');
```

###Client
``` javascript
var Client = require('pomelo-rpc').client;

// remote service interface path info list
var records = [
  {namespace: 'user', serverType: 'test', path: __dirname + '/remote/test'}
];

// server info list
var servers = [
  {id: 'test-server-1', serverType: 'test', host: '127.0.0.1', port: 3333}
];

// route parameter passed to route function
var routeParam = null;

// route context passed to route function
var routeContext = servers;

// route function to calculate the remote server id
var routeFunc = function(routeParam, msg, routeContext, cb) {
  cb(null, routeContext[0].id);
};

var client = Client.create({routeContext: routeContext, router: routeFunc});

client.start(function(err) {
  console.log('rpc client start ok.');

  client.addProxies(records);
  client.replaceServers(servers);

  client.proxies.user.test.service.echo(routeParam, 'hello', function(err, resp) {
    if(err) {
      console.error(err.stack);
    }
    console.log(resp);
  });
});
```

##Server API
###Server.create(opts)
Create a RPC server instance. Initiates the instance and acceptor with the configuration.
###Parameters
+ opts.port - rpc server listening port.
+ opts.paths - remote service path infos, format: [{namespace: remote service namespace, path: remote service path}, ...].
+ opts.context - remote service context.
+ opts.acceptorName - (optional) `'ws'` for WebSocket transport; default is TCP.
+ opts.acceptorFactory - (optional) acceptor factory object with `create(opts, msgCB)` returning an acceptor instance. opts.port: port to listen on; opts.services: loaded remote services, format: `{namespace: {name: service}}`. msgCB(tracer, msg, cb): remote request callback. Omit to use the default TCP or WS acceptor.

###server.start
Start the remote server instance.

###server.stop
Stop the remote server instance and the acceptor.

###Acceptor
Implements the low-level network communication for a protocol. The server uses TCP by default; set opts.acceptorName to `'ws'` or pass a custom acceptorFactory to use a different transport.

###acceptor.listen(port)
Listen the specified port.

###acceptor.close
Stop the acceptor.

##Client API
###Client.create(opts)
Create an RPC client instance which would generate proxies for the RPC client.
####Parameters
+ opts.context - context for mailbox.
+ opts.routeContext - (optional)context for route function.
+ opts.router(routeParam, msg, routeContext, cb) - (optional) route function which decides which remote server receives the RPC message. Default is a consistent-hash router; when using the default, routeContext must provide getServersByType(serverType). routeParam: route parameter, msg: RPC description message, routeContext: opts.routeContext. cb(err, serverId).
+ opts.mailBoxFactory(serverInfo, opts) - (optional) mail box factory method.

###client.addProxies(records)
Load new proxy codes.
####Parameters
+ records - new proxy code configure information list. Format: [{namespace: service_name_space, serverType: remote_server_type, path: path_to_remote_service_interfaces}].

###client.replaceServers(servers)
Replace the list of remote server infos. Format: [{id, serverType, host, port}, ...]. Call after start to update servers dynamically.

###client.start(cb)
Start the RPC client.

###client.stop(force)
Stop the RPC client and close all mailbox connections to remote servers. force (optional): if true, close mailboxes immediately.

###client.rpcInvoke(serverId, msg, cb)
Invoke an RPC request.
####Parameters
+ serverId - remote server id.
+ msg - RPC description message. format: {namespace: remote service namespace, serverType: remote server type, service: remote service name, method: remote service method name, args: remote service args}.
+ cb - remote service callback function.

##Tracing (OpenTelemetry)
Distributed tracing is supported via **OpenTelemetry**. Install the optional dependency and register an SDK to see RPC calls as spans:

```bash
npm install @opentelemetry/api
# and an SDK / exporter, e.g. @opentelemetry/sdk-trace-base + your exporter
```

+ **Client**: each outbound RPC gets a client span; trace context is propagated in the RPC packet.
+ **Server**: each inbound RPC gets a server span; context is extracted and span names are `service::method`. Peer address/port are added as span attributes when available.
+ If `@opentelemetry/api` is not installed, tracing is skipped with no overhead. If the API is installed but no tracer is active (no SDK registered), no-op adapters are used so there are no per-RPC allocations.

###MailBox
Implement the low level network communication with remote server. A mail box instance stands for a remote server. Customize the protocol by passing a mailBoxFactory parameter to client to return different mail box instances.

#### TCP handshake and compatibility
TCP connections use an optional handshake to negotiate compression (e.g. deflate). When only one side is upgraded: **old client → new server** works (server treats the connection as legacy). **New client → old server** can break because the old server may misparse the handshake. When connecting to a legacy server, pass **`handshake: false`** in the client/mailbox opts so the client skips the handshake and uses plain Composer.

#### Optional compression (lz4, snappy)
Compression is negotiated in the handshake. **deflate** is built-in (zlib). **lz4** and **snappy** are optional: install the corresponding optional dependency to enable them (`lz4`, `snappy-stream`). If an optional compressor is negotiated but not installed, the connection falls back to no compression and a warning is logged.

###mailbox.connect(tracer, cb)
Connect to the remote server. tracer: RPC tracer for the connection.

###mailbox.close
Close mail box instance and disconnect with the remote server.

###mailbox.send(tracer, msg, opts, cb)
Send the RPC message to the associated remote server. Used internally; custom mailbox implementations must use this signature.
####Parameters
+ tracer - RPC tracer for the request.
+ msg - RPC description message, see also client.rpcInvoke.
+ opts - reserved.
+ cb - RPC callback function.