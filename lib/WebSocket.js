/*!
 * ws: a node.js websocket client
 * Copyright(c) 2011 Einar Otto Stangvik <einaros@gmail.com>
 * MIT Licensed
 */

var util = require('util')
  , events = require('events')
  , http = require('http')
  , https = require('https')
  , crypto = require('crypto')
  , url = require('url')
  , fs = require('fs')
  , Options = require('options')
  , Sender = require('./Sender')
  , Receiver = require('./Receiver');

/**
 * Constants
 */

var protocolPrefix = "HyBi-";
var protocolVersion = 13;

/**
 * WebSocket implementation
 */

function WebSocket(address, options) {
  if (Object.prototype.toString.call(address) == '[object Array]') {
    /**
     * Act as server client
     */

    options = new Options({
      protocolVersion: protocolVersion,
      protocol: null
    }).merge(options);

    // Exposed properties
    Object.defineProperty(this, 'protocol', {
      value: options.value.protocol,
      configurable: false,
      enumerable: true
    });
    Object.defineProperty(this, 'protocolVersion', {
      value: options.value.protocolVersion,
      configurable: false,
      enumerable: true
    });
    Object.defineProperty(this, 'upgradeReq', {
      value: address[0],
      configurable: false,
      enumerable: true
    });

    Object.defineProperty(this, '_readyState', { writable: true, value: WebSocket.CONNECTING });
    Object.defineProperty(this, '_isServer', { writable: true, value: true });
    var self = this;
    process.nextTick(function() {
      upgrade.apply(self, address);
    });
  }
  else {
    /**
     * Act as regular client
     */

    Object.defineProperty(this, '_isServer', { writable: true, value: false });

    var serverUrl = url.parse(address);
    if (!serverUrl.host) throw new Error('invalid url');
    var httpObj = (serverUrl.protocol === 'wss:' || serverUrl.protocol === 'https:') ? https : http;
    
    Object.defineProperty(this, 'url', {
      writable: false,
      configurable: false,
      enumerable: true,
      value: address
    });

    options = new Options({
      origin: null,
      protocolVersion: protocolVersion,
      protocol: null
    }).merge(options);
    if (options.value.protocolVersion != 8 && options.value.protocolVersion != 13) {
      throw new Error('unsupported protocol version');
    }

    var key = new Buffer(options.value.protocolVersion + '-' + Date.now()).toString('base64');
    var shasum = crypto.createHash('sha1');
    shasum.update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
    var expectedServerKey = shasum.digest('base64');

    // node<=v0.4.x compatibility
    var isNodeV4 = false;
    var agent;
    if (/^v0\.4/.test(process.version)) {
      isNodeV4 = true;
      agent = new httpObj.Agent({
        host: serverUrl.hostname,
        port: serverUrl.port || 80
      });
    }

    var requestOptions = {
      port: serverUrl.port || 80,
      host: serverUrl.hostname,
      headers: {
        'Connection': 'Upgrade',
        'Upgrade': 'websocket',
        'Sec-WebSocket-Version': options.value.protocolVersion,
        'Sec-WebSocket-Key': key
      }
    };
    if (options.value.protocol) {
      requestOptions.headers['Sec-WebSocket-Protocol'] = options.value.protocol;
    }
    if (isNodeV4) {
      requestOptions.path = (serverUrl.pathname || '/') + (serverUrl.search || '');
      requestOptions.agent = agent;
    }
    else requestOptions.path = serverUrl.path || '/';
    if (options.value.origin) {
      if (options.value.protocolVersion < 13) requestOptions.headers['Sec-WebSocket-Origin'] = options.value.origin;
      else requestOptions.headers['Origin'] = options.value.origin;
    }

    var req = httpObj.request(requestOptions);
    var self = this;
    (isNodeV4 ? agent : req).on('error', function(error) {
      self.emit('error', error);
    });
    (isNodeV4 ? agent : req).on('upgrade', function(res, socket, upgradeHead) {
      if (self.readyState == WebSocket.CLOSED) {
        // client closed before server accepted connection
        self.emit('close');
        socket.end();
        return;
      }
      var serverKey = res.headers['sec-websocket-accept'];
      if (typeof serverKey == 'undefined' || serverKey !== expectedServerKey) {
        self.emit('error', 'invalid server key');
        socket.end();
        return;
      }

      upgrade.call(self, res, socket, upgradeHead);
    });

    req.end();
    Object.defineProperty(this, '_readyState', { writable: true, value: WebSocket.CONNECTING });
  }

  var realEmit = this.emit;
  this.emit = function(event) {
    if (event == 'error') delete this._queue;
    realEmit.apply(this, arguments);
  }
  Object.defineProperty(this, '_socket', { writable: true, value: null });
  Object.defineProperty(this, 'readyState', {
    get: function() {
      return this._readyState;
    }
  });
}

/**
 * Ready States
 */

(function() {
  var readyStates = {
      CONNECTING: 0
    , OPEN: 1
    , CLOSING: 2
    , CLOSED: 3
  };

  for (var state in readyStates) {
    if (!readyStates.hasOwnProperty(state)) continue;
    Object.defineProperty(WebSocket, state, { enumerable: true, value: readyStates[state]});
  }
})();

/**
 * Inherits from EventEmitter.
 */

util.inherits(WebSocket, events.EventEmitter);

/**
 * Gracefully closes the connection, after sending a description message to the server
 *
 * @param {Object} data to be sent to the server
 * @api public
 */

WebSocket.prototype.close = function(code, data) {
  if (this.readyState == WebSocket.CLOSING) return;
  if (this.readyState == WebSocket.CONNECTING) {
    this._readyState = WebSocket.CLOSED;
    return;
  }
  if (this.readyState != WebSocket.OPEN) throw new Error('not opened');
  try {
    this._readyState = WebSocket.CLOSING;
    this._closeCode = code;
    this._closeMessage = data;
    var mask = !this._isServer;
    this._sender.close(code, data, mask);
    this.terminate();
  }
  catch (e) {
    this.emit('error', e);
  }
}

/**
 * Sends a ping
 *
 * @param {Object} data to be sent to the server
 * @param {Object} Members - mask: boolean, binary: boolean
 * @api public
 */

WebSocket.prototype.ping = function(data, options) {
  if (this.readyState != WebSocket.OPEN) throw new Error('not opened');
  options = options || {};
  if (typeof options.mask == 'undefined') options.mask = !this._isServer;
  this._sender.ping(data, options);
}

/**
 * Sends a pong
 *
 * @param {Object} data to be sent to the server
 * @param {Object} Members - mask: boolean, binary: boolean
 * @api public
 */

WebSocket.prototype.pong = function(data, options) {
  if (this.readyState != WebSocket.OPEN) throw new Error('not opened');
  options = options || {};
  if (typeof options.mask == 'undefined') options.mask = !this._isServer;
  this._sender.pong(data, options);
}

/**
 * Sends a piece of data
 *
 * @param {Object} data to be sent to the server
 * @param {Object} Members - mask: boolean, binary: boolean
 * @param {function} Optional callback which is executed after the send completes
 * @api public
 */

WebSocket.prototype.send = function(data, options, cb) {
  if (typeof options == 'function') {
    cb = options;
    options = {};
  }
  if (this.readyState != WebSocket.OPEN) {
    if (typeof cb == 'function') cb(new Error('not opened'));
    else throw new Error('not opened');
    return;
  }
  if (!data) data = '';
  if (this._queue) {
    var self = this;
    this._queue.push(function() { self.send(data, options, cb); });
    return;
  }
  options = options || {};
  options.fin = true;
  if (typeof options.mask == 'undefined') options.mask = !this._isServer;
  if (data instanceof fs.ReadStream) {
    startQueue(this);
    var self = this;
    sendStream(this, data, options, function(error) {
      process.nextTick(function() { executeQueueSends(self); });
      if (typeof cb == 'function') cb(error);
    });
  }
  else this._sender.send(data, options, cb);
}

/**
 * Streams data through calls to a user supplied function
 *
 * @param {Object} Members - mask: boolean, binary: boolean
 * @param {function} 'function (error, send)' which is executed on successive ticks of which send is 'function (data, final)'.
 * @api public
 */

WebSocket.prototype.stream = function(options, cb) {
  if (typeof options == 'function') {
    cb = options;
    options = {};
  }
  if (typeof cb != 'function') throw new Error('callback must be provided');
  if (this.readyState != WebSocket.OPEN) {
    if (typeof cb == 'function') cb(new Error('not opened'));
    else throw new Error('not opened');
    return;
  }
  if (this._queue) {
    var self = this;
    this._queue.push(function() { self.stream(options, cb); });
    return;
  }
  options = options || {};
  if (typeof options.mask == 'undefined') options.mask = !this._isServer;
  startQueue(this);
  var self = this;
  var send = function(data, final) {
    try {
      if (self.readyState != WebSocket.OPEN) throw new Error('not opened');
      options.fin = final === true;
      self._sender.send(data, options);
      if (!final) process.nextTick(cb.bind(null, null, send));
      else executeQueueSends(self);
    }
    catch (e) {
      if (typeof cb == 'function') cb(e);
      else self.emit('error', e);
    }
  }
  process.nextTick(cb.bind(null, null, send));
}

/**
 * Immediately shuts down the connection
 *
 * @api public
 */

WebSocket.prototype.terminate = function() {
  if (this._socket) {
    this._socket.end();
    this._socket = null;
  }
  else if (this.readyState == WebSocket.CONNECTING) {
    this._readyState = WebSocket.CLOSED;
  }
};

/**
 * Emulates the Browser based WebSocket interface.
 *
 * @see http://dev.w3.org/html5/websockets/#the-websocket-interface
 * @api public
 */

['open', 'error', 'close', 'message'].forEach(function(method) {
  Object.defineProperty(WebSocket.prototype, 'on' + method, {
    /**
     * Returns the current listener
     *
     * @returns {Mixed} the set function or undefined
     * @api public
     */

    get: function get() {
      var listener = this.listeners(method)[0];
      return listener ? (listener._listener ? listener._listener : listener) : undefined;
    },

    /**
     * Start listening for events
     *
     * @param {Function} listener the listener
     * @returns {Mixed} the set function or undefined
     * @api public
     */

    set: function set(listener) {
      this.removeAllListeners(method);

      if (typeof listener === 'function') {
        // Special case for messages as we need to wrap the response here to
        // emulate a WebSocket event response.
        if (method === 'message') {
          function message (data) {
            listener.call(this, { data: data });
          }

          // store a reference so we can return the origional function again
          message._listener = listener;
          this.on(method, message);
        } else {
          this.on(method, listener);
        }
      }
    }
  });
});

module.exports = WebSocket;

/**
 * Entirely private apis,
 * which may or may not be bound to a sepcific WebSocket instance.
 */

function upgrade(res, socket, upgradeHead) {
  this._socket = socket;
  socket.setTimeout(0);
  socket.setNoDelay(true);
  var self = this;
  socket.on('end', function() {
    if (self.readyState == WebSocket.CLOSED) return;
    self._readyState = WebSocket.CLOSED;
    self.emit('close', self._closeCode || 1000, self._closeMessage || '');
  });
  socket.on('close', function() {
    if (self.readyState == WebSocket.CLOSED) return;
    self._readyState = WebSocket.CLOSED;
    self.emit('close', self._closeCode || 1000, self._closeMessage || '');
  });

  var receiver = new Receiver();
  socket.on('data', function (data) {
    receiver.add(data);
  });
  receiver.on('text', function (data, flags) {
    flags = flags || {};
    self.emit('message', data, flags);
  });
  receiver.on('binary', function (data, flags) {
    flags = flags || {};
    flags.binary = true;
    self.emit('message', data, flags);
  });
  receiver.on('ping', function(data, flags) {
    flags = flags || {};
    self.pong(data, {mask: !self._isServer, binary: flags.binary === true});
    self.emit('ping', data, flags);
  });
  receiver.on('close', function(code, data, flags) {
    flags = flags || {};
    self.close(code, data, {mask: !self._isServer});
  });
  receiver.on('error', function(reason, errorCode) {
    // close the connection when the receiver reports a HyBi error code
    if (typeof errorCode !== 'undefined') {
      self.close(errorCode, '', {mask: !self._isServer});
    }
    self.emit('error', reason, errorCode);
  });

  Object.defineProperty(this, '_sender', { value: new Sender(socket) });
  this._sender.on('error', function(error) {
    self.emit('error', error);
  });
  this._readyState = WebSocket.OPEN;
  this.emit('open');

  if (upgradeHead && upgradeHead.length > 0) receiver.add(upgradeHead);
}

function startQueue(instance) {
  instance._queue = instance._queue || [];
}

function executeQueueSends(instance) {
  var queue = instance._queue;
  if (typeof queue == 'undefined') return;
  delete instance._queue;
  for (var i = 0, l = queue.length; i < l; ++i) {
    queue[i]();
  }
}

function sendStream(instance, stream, options, cb) {
  stream.on('data', function(data) {
    if (instance.readyState != WebSocket.OPEN) {
      if (typeof cb == 'function') cb(new Error('not opened'));
      else instance.emit('error', new Error('not opened'));
      return;
    }
    options.fin = false;
    instance._sender.send(data, options);
  });
  stream.on('end', function() {
    if (instance.readyState != WebSocket.OPEN) {
      if (typeof cb == 'function') cb(new Error('not opened'));
      else instance.emit('error', new Error('not opened'));
      return;
    }
    options.fin = true;
    instance._sender.send(null, options);
    if (typeof cb == 'function') cb(null);
  });
}
