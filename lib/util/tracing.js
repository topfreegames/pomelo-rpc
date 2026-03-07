/**
 * OpenTelemetry-based tracing for pomelo-rpc.
 * If @opentelemetry/api is not installed, we never load it (zero heap from OTel).
 * If installed but no SDK is registered, we avoid per-RPC allocations via shared no-op adapters.
 */

var api;
try {
  api = require('@opentelemetry/api');
} catch (e) {
  api = null;
}

var trace = api && api.trace;
var context = api && api.context;
var propagation = api && api.propagation;
var SpanStatusCode = api && api.SpanStatusCode;

var TRACER_NAME = 'pomelo-rpc';
var TRACER_VERSION = '3.0.0';

var tracer = trace ? trace.getTracer(TRACER_NAME, TRACER_VERSION) : null;

// When null, unknown (not yet probed) or OTel not loaded. When false, tracing disabled. When true, tracing enabled.
var tracingEnabled = api === null ? false : null;

// Shared no-op adapters: reused for every RPC when tracing is disabled to avoid any heap allocations.
// isNoop lets callers skip building tag objects when tracing is disabled.
var noopClientAdapter = {
  isNoop: true,
  inject: function() {},
  addTags: function() {},
  finish: function() {},
  runAfterFinish: function(fn) { fn(); }
};
var noopServerAdapter = {
  isNoop: true,
  finish: function() {},
  runInContext: function(fn) { fn(); }
};

// RPC package carrier: store trace context in pkg._traceContext so we don't clash with existing fields
function setCarrier(carrier, key, value) {
  if (!carrier) return;
  if (!carrier._traceContext) carrier._traceContext = {};
  carrier._traceContext[key] = value;
}

function getCarrier(carrier, key) {
  if (!carrier || !carrier._traceContext) return undefined;
  return carrier._traceContext[key];
}

/**
 * Create a client span for an outbound RPC call.
 * Returns an adapter with inject(pkg), addTags(attrs), finish(err), runAfterFinish(fn).
 * When tracing is disabled, returns a shared no-op adapter (zero allocations).
 */
function createClientSpan(serviceMethod, attributes) {
  if (tracingEnabled === false) {
    return noopClientAdapter;
  }
  if (tracingEnabled === null && tracer) {
    var probeSpan = tracer.startSpan('_');
    tracingEnabled = probeSpan.isRecording();
    if (!tracingEnabled) {
      return noopClientAdapter;
    }
  }
  if (!tracer) {
    return noopClientAdapter;
  }

  var parentContext = context.active();
  var span = tracer.startSpan(serviceMethod, {
    attributes: Object.assign(
      { 'span.kind': 'client' },
      attributes || {}
    )
  });
  var ctxWithSpan = trace.setSpan(parentContext, span);

  return {
    inject: function inject(pkg) {
      if (!pkg) return;
      propagation.inject(ctxWithSpan, pkg, setCarrier);
    },
    addTags: function addTags(tags) {
      if (!tags || !span) return;
      span.setAttributes(tags);
    },
    finish: function finish(err) {
      if (!span) return;
      if (err) {
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      }
      span.end();
    },
    runAfterFinish: function runAfterFinish(fn) {
      context.with(parentContext, fn);
    }
  };
}

/**
 * Create a server span for an inbound RPC call.
 * Extracts context from pkg (if any) and returns an adapter with
 * finish(err), runInContext(fn). When tracing is disabled, returns a shared no-op adapter (zero allocations).
 */
function createServerSpan(pkg, serviceMethod, attributes) {
  if (tracingEnabled === false) {
    return noopServerAdapter;
  }
  if (tracingEnabled === null && tracer) {
    var probeSpan = tracer.startSpan('_');
    tracingEnabled = probeSpan.isRecording();
    if (!tracingEnabled) {
      return noopServerAdapter;
    }
  }
  if (!tracer) {
    return noopServerAdapter;
  }

  var extractedContext = propagation.extract(context.active(), pkg || {}, getCarrier);
  var span;
  context.with(extractedContext, function() {
    span = tracer.startSpan(serviceMethod, {
      attributes: Object.assign(
        { 'span.kind': 'server' },
        attributes || {}
      )
    });
  });
  var ctxWithSpan = trace.setSpan(extractedContext, span);

  return {
    finish: function finish(err) {
      if (!span) return;
      if (err) {
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      }
      span.end();
    },
    runInContext: function runInContext(fn) {
      context.with(ctxWithSpan, fn);
    }
  };
}

module.exports = {
  createClientSpan: createClientSpan,
  createServerSpan: createServerSpan
};
