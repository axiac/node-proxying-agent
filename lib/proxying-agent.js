'use strict';

var url = require('url');
var http = require('http');
var httpRequest = http.request;
var https = require('https');
var httpsRequest = https.request;
var tls = require('tls');
var util = require('util');
var ntlm = require('./ntlm');

function ProxyingAgent(options, agent) {
  this.openSockets = {};
  this.options = util._extend({}, options);
  this.options.proxy = url.parse(this.options.proxy);
  this.options.tunnel = this.options.tunnel || false;
  this.options.ssl = this.options.proxy.protocol ? this.options.proxy.protocol.toLowerCase() == 'https:' : false;
  this.options.host = this.options.proxy.hostname;
  this.options.port = this.options.proxy.port || (this.options.ssl ? 443 : 80);
  this.options.authType = this.options.authType || 'basic';

  if (this.options.authType === 'ntlm') {
    if (!this.options.proxy.auth) {
      throw new Error('NTLM authentication credentials must be provided');
    }
    if (!this.options.ntlm || !this.options.ntlm.domain) {
      throw new Error('NTLM domain must be provided');
    }
  }

  // base64 decode proxy auth if necessary
  var auth = this.options.proxy.auth;
  if (auth && auth.indexOf(':') == -1) {
    auth = new Buffer(auth, 'base64').toString('ascii');
    // if after decoding there still isn't a colon, then revert back to the original value
    if (auth.indexOf(':') == -1) {
      auth = this.options.proxy.auth;
    }
    this.options.proxy.auth = auth;
  }

  // select the Agent type to use based on the proxy protocol
  this.agent = agent;
  this.agent.call(this, this.options);
}

/**
 * Get absolutURI without port when using default
 */
ProxyingAgent.prototype.getAbsoluteURI = function(ssl, host, port, path) {
  var absoluteUri = (ssl ? 'https://' : 'http://') + host;

  if (typeof port === 'string') {
    // Check if target url have specified port and add it to absoluteUri
    // When port is defined in target url then we get it as a string otherwise it's a number
    absoluteUri += ':' + port;
  }

  absoluteUri += path;

  return absoluteUri;
};

/**
 * Overrides the 'addRequest' Agent method for establishing a socket with the proxy
 * that will e used to issue the actual request
 */
ProxyingAgent.prototype.addRequest = function(req, host, port) {
  if (typeof host === 'object') {
    port = host.port;
    host = host.hostname || host.host;
  }
  if (this.options.authType === 'ntlm') {
    this.startNtlm(req, host, port);
  } else {
    this.startProxying(req, host, port);
  }
};

/**
 * Start proxying the request through the proxy server.
 * This automatically opens a tunnel through the proxy if needed,
 * or just issues a regular request for the proxy to transfer
 */
ProxyingAgent.prototype.startProxying = function(req, host, port) {

  // setup the basic authentication header for the proxy.
  // we do this only if we haven't already authenticated through NTLM
  if (this.options.authType == 'basic' && this.options.proxy.auth) {
    this.authHeader = {
      header: 'Proxy-Authorization',
      value: 'Basic ' + new Buffer(this.options.proxy.auth).toString('base64')
    }
  }

  // if we need to create a tunnel to the server via the CONNECT method
  if (this.options.tunnel) {
    var tunnelOptions = util._extend({}, this.options);
    tunnelOptions.method = 'CONNECT';
    tunnelOptions.path = host+':'+port;
    tunnelOptions.hostname = this.options.proxy.hostname;
    tunnelOptions.port = this.options.proxy.port;
    tunnelOptions.headers = tunnelOptions.headers || {};

    // if we already have a socket open then execute the CONNECT method on it
    var socket = this.getSocket(req);
    if (socket) {
      tunnelOptions.agent = new SocketAgent(socket);
    }

    // add the authentication header
    if (this.authHeader) {
      tunnelOptions.headers[this.authHeader.header] = this.authHeader.value;
      if (this.authHeader.keepAlive) {
        tunnelOptions.headers["Proxy-Connection"] = "Keep-Alive";
      }
    }

    // create a new CONNECT request to the proxy to create the tunnel
    // to the server
    var newReq = this.createNewRequest(tunnelOptions);

    newReq.once('close', function() {
      this.emitError(req, 'Tunnel creation failed. Socket closed prematurely');
    }.bind(this));

    newReq.once('error', function(error) {
      this.emitError(req, 'Tunnel creation failed. Socket error: ' + error);
    }.bind(this));

    // listen for the CONNECT event to complete and execute the original request
    // on the TLSed socket
    newReq.once('connect', function(response, socket, head) {
      newReq.removeAllListeners();
      if (response.statusCode != 200) {
        this.emitError(req, 'Tunnel creation failed. Received status code ' + response.statusCode);
        return;
      }
      var tlsOptions = this.options.tlsOptions || {};
      tlsOptions.socket = response.socket;
      tlsOptions.servername = host;

      // upgrade the socket to TLS
      var tlsSocket = tls.connect(tlsOptions, function() {
        this.setSocket(req, tlsSocket);
        this.execRequest(req, this.options.host, this.options.port);
      }.bind(this));

      tlsSocket.once('error', function(error) {
        this.emitError(req, 'Tunnel socket error: ' + error);
      }.bind(this));

    }.bind(this));

    // execute the CONNECT method to create the tunnel
    newReq.end();
  } else {
    // issue a regular proxy request
    req.path = this.getAbsoluteURI(this.options.ssl, host, port, req.path);
    if (this.authHeader) {
      req.setHeader(this.authHeader.header, this.authHeader.value);
    }
    this.execRequest(req, this.options.host, this.options.port);
  }
};

/**
 * Start an NTLM authentication process. The result is an open socket that will be used
 * to issue the actual request or open a tunnel on
 */
ProxyingAgent.prototype.startNtlm = function(req, host, port) {
  var ntlmOptions = util._extend({}, this.options);
  ntlmOptions.method = ntlmOptions.method || 'GET'; // just for the NTLM handshake
  ntlmOptions.path = this.getAbsoluteURI(this.options.ssl, host, port, req.path);
  ntlmOptions.ntlm.workstation = ntlmOptions.ntlm.workstation || require('os').hostname();

  var creds = this.options.proxy.auth.match(/([^:]*):?(.*)/);
  ntlmOptions.ntlm.username = creds[1];
  ntlmOptions.ntlm.password = creds[2];

  // set the NTLM type 1 message header
  ntlmOptions.headers = ntlmOptions.headers || {};
  ntlmOptions.headers['Proxy-Authorization'] = ntlm.createType1Message(ntlmOptions.ntlm);
  ntlmOptions.headers['Proxy-Connection'] = "Keep-Alive";

  // create the NTLM type 1 request
  var newReq = this.createNewRequest(ntlmOptions);

  // capture the response and set the NTLM type 3 authorization header
  // that will be used when issuing the actual request
  newReq.once('response', function(response) {
    if (response.statusCode !== 407 || !response.headers['proxy-authenticate']) {
      this.emitError(req, 'did not receive NTLM type 2 message');
      return;
    }
    var type2msg = ntlm.parseType2Message(response.headers['proxy-authenticate'], function(error) {
      this.emitError(req, error);
      return null;
    }.bind(this));

    if (!type2msg) {
      return;
    }

    // capture the socket
    this.setSocket(req, response.socket);

    this.authHeader = {
      header: 'Proxy-Authorization',
      value: ntlm.createType3Message(type2msg, ntlmOptions.ntlm),
      keepAlive: true
    }

    // read all the data from the socket as it may contain a body that should be discarded
    response.on('data', function() {
      // just consume the body
    }.bind(this));

    // start proxying
    this.startProxying(req, host, port);

  }.bind(this));

  // start proxying the actual request only when there is not more body to read.
  // the socket should have already been captured and associated with the request
  newReq.once('close', function() {
    this.emitError(req, 'NTLM failed. Socket closed prematurely');
  }.bind(this));

  newReq.once('error', function(error) {
    this.emitError(req, 'NTLM failed. Socket error: ' + error);
  }.bind(this));

  // issue the NTLM type 1 request
  newReq.end();
};

/**
 * Create a new request instance according the needed security
 */
ProxyingAgent.prototype.createNewRequest = function(options) {
  if (options.ssl) {
    return new httpsRequest(options);
  }
    return new httpRequest(options);
};

/**
 * Execute the provided request by invoking the original Agent 'addRequest' method.
 * If there is already a socket that was associated with the request, then it
 * will be used for issuing the request (via the 'createSocket' method)
 */
ProxyingAgent.prototype.execRequest = function(req, host, port) {
  this.agent.prototype.addRequest.call(this, req, host, port);

  // if there is an associated socket to this request then the association is removed
  // since the socket was already passed to the request
  if (this.openSockets[req]) {
    delete this.openSockets[req];
  }
};

/**
 * Remember a socket and associate it with a specific request.
 * When the 'createSocket' method will be called to execute the actual request
 * then the already existing socket will be used
 */
ProxyingAgent.prototype.setSocket = function(req, socket) {

  this.openSockets[req] = socket;
  var onClose = function() {
    if (this.openSockets[req]) {
      delete this.openSockets[req];
    }
  }.bind(this);
  this.openSockets[req].on('close', onClose);
};

ProxyingAgent.prototype.getSocket = function(req) {
  return this.openSockets[req];
};

/**
 * This is called during the 'addRequest' call of the original Agent to return a
 * new socket for executing the request. If a socket already exists then it is used
 * instead of creating a new one.
 */
ProxyingAgent.prototype.createSocket = function() {

  var req;
  var cb;
  if (typeof arguments[0] === 'object') {
    req = arguments[0];
    cb = arguments[2];
  } else {
    req = arguments[4];
  }

  if (this.openSockets[req]) {
    if (cb) {
      return cb(null, this.openSockets[req]);
    } else {
      return this.openSockets[req];
    }
  }
  return this.agent.prototype.createSocket.apply(this, arguments);
};

ProxyingAgent.prototype.emitError = function(req, message) {
  (req.socket || req).emit('error', new Error(message));
};


//======= SocketAgent

/**
 * A simple agent to execute a request on a given socket
 */
function SocketAgent(socket) {
  this.socket = socket;
}

SocketAgent.prototype.addRequest = function(req, host, port) {
  req.onSocket(this.socket);
};

/**
 * HttpProxyingAgent
 * @param options
 * @constructor
 */
function HttpProxyingAgent(options) {
  ProxyingAgent.call(this, options, http.Agent);
}
util.inherits(HttpProxyingAgent, http.Agent);
util._extend(HttpProxyingAgent.prototype, ProxyingAgent.prototype);

/**
 * HttpsProxyingAgent
 * @param options
 * @constructor
 */
function HttpsProxyingAgent(options) {
  options.tunnel = true;
  ProxyingAgent.call(this, options, https.Agent);
}
util.inherits(HttpsProxyingAgent, https.Agent);
util._extend(HttpsProxyingAgent.prototype, ProxyingAgent.prototype);

/**
 * Create the proxying agent
 * @param proxy
 * @param target
 * @returns {*}
 */
exports.create = function(proxy, target) {
  if (typeof proxy === 'string') {
    proxy = {proxy: proxy}
  }

  if (target.toLowerCase().indexOf('https:') === 0) {
    return new HttpsProxyingAgent(proxy);
  }
  return new HttpProxyingAgent(proxy);
};

/**
 * Set a global agent to forward all http and https requests through the specified proxy
 * @param proxy
 */
exports.globalize = function (proxy) {
    var copyProxy = JSON.parse(JSON.stringify(proxy));
    var copySecureProxy = JSON.parse(JSON.stringify(proxy));
    var secureAgent = this.create(copySecureProxy, 'https://');
    var nonSecureAgent = this.create(copyProxy, 'http://');

    http.request = function (options, callback) {
        if (typeof options === 'string') {
            options = url.parse(options);
        }
        if (!options.agent) {
          options.agent = nonSecureAgent;
        }
        return httpRequest(options, callback);
    };

    http.get = function get(options, cb) {
        const req = http.request(options, cb);
        req.end();
        return req;
    };

    https.request = function (options, callback) {
        if (typeof options === 'string') {
            options = url.parse(options);
        }
        if (!options.agent) {
            options.agent = secureAgent;
        }
        return httpsRequest(options, callback);
    };
    https.get = function get(options, cb) {
        const req = https.request(options, cb);
        req.end();
        return req;
    };
};
