// # Telepat Javascript Client
// **Telepat** is an open-source backend stack, designed to deliver information
// and information updates in real-time to clients, while allowing for flexible deployment and simple scaling.

import fs from 'fs';
import PouchDB from 'pouchdb';
import API from './api';
import log from './logger';
import error from './error';
import EventObject from './event';
import Monitor from './monitor';
import Channel from './channel';
import User from './user';

// ## Telepat Class
// You use the Telepat class to connect to the backend, login, subscribe and unsubscribe to channels.
// The object has properties you can access:
//
// * `contexts`, an array of all the available contexts represented as JSON objects
// * `subscriptions`, an object that holds references to
// [Channel](http://docs.telepat.io/telepat-js/lib/channel.js.html) objects, on keys named after the respective channel

export default class Telepat {
  constructor() {
    function getUserHome() {
      return process.env[(process.platform === 'win32') ? 'USERPROFILE' : 'HOME'];
    }

    function getTelepatDir() {
      var dir = getUserHome() + '/.telepat-cli';

      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, 744);
      }
      return dir;
    }

    this._db = new PouchDB((typeof window !== 'undefined') ? '/_telepat' : getTelepatDir());
    this._event = new EventObject(log);
    this._monitor = new Monitor();
    this._socketEndpoint = null;
    this._socket = null;
    this._persistentConnectionOptions = null;
    this._sessionId = null;

    this.connected = false;
    this.connecting = false;
    this.configured = false;
    this.currentAppId = null;
    this.contexts = null;
    this.subscriptions = {};
    this.admin = null;
    this.user = null;
    this.contextEvent = new EventObject(log);
  }

  getContexts(callback = () => {}) {
    API.get('context/all', '', (err, res) => {
      if (err) {
        let error = error('Error retrieving contexts ' + err);

        this.callback(error, null);
        this._event.emit('error', error);
      } else {
        this._monitor.remove({channel: {model: 'context'}});
        this.contexts = {};
        for (let index in res.body.content) {
          this.contexts[res.body.content[index].id] = res.body.content[index];
        }

        this._monitor.add({channel: {model: 'context'}}, this.contexts, this.contextEvent, this._addContext.bind(this), this._deleteContext.bind(this), this._updateContext.bind(this));
        this.contextEvent.on('update', (operation, parentId, parentObject, delta) => {
          this._event.emit('contexts-update');
        });
        callback(null, this.contexts);
        this._event.emit('contexts-update');
      }
    });
  }

  _addContext(context, callback = () => {}) {
    if (this.admin) {
      this.admin.addContext(context, callback);
    } else {
      log.warn('Editing context data as non-admin user. Changes will not be remotely persisted.');
    }
  }

  _updateContext(id, patches, callback = () => {}) {
    if (this.admin) {
      this.admin.updateContext(id, patches, callback);
    } else {
      log.warn('Editing context data as non-admin user. Changes will not be remotely persisted.');
    }
  }

  _deleteContext(id, callback = () => {}) {
    if (this.admin) {
      this.admin.deleteContext(id, callback);
    } else {
      log.warn('Editing context data as non-admin user. Changes will not be remotely persisted.');
    }
  }

  _updateUser(reauth = false, callback = () => {}) {
    if (!this.user) {
      this.user = new User(this._db, this._event, this._monitor, newAdmin => { this.admin = newAdmin; }, () => {
        if (reauth) {
          this.user.reauth(callback);
        } else {
          callback(null);
        }
      });
    } else {
      callback(null);
    }
  }

  /**
   * ## Telepat.configure
   *
   * Call this to configure Telepat server endpoints without connecting to a specific app.
   *
   * @param {object} options Object containing all configuration options for connection
   */
  configure(options = {}, callback = () => {}) {
    if (typeof options.apiEndpoint !== 'undefined') {
      API.apiEndpoint = options.apiEndpoint + '/';
    } else {
      callback(error('Configure options must provide an apiEndpoint property'));
    }
    // - `socketEndpoint`: the host and port number for the socket service
    if (typeof options.socketEndpoint !== 'undefined') {
      this._socketEndpoint = options.socketEndpoint;
    } else {
      callback(error('Configure options must provide an socketEndpoint property'));
    }

    this._updateUser(options.reauth, () => {
      this._event.emit('configure');
      this.configured = true;
      callback(null, this);
    });
  }

  /**
   * ## Telepat.connect
   *
   * This is the first function you should call to connect to the Telepat backend.
   *
   * @param {object} options Object containing all configuration options for connection
   */
  connect(options, callback = () => {}) {
    var self = this;

    function completeRegistration(res) {
      if (res.body.content.identifier !== undefined) {
        API.UDID = res.body.content.identifier;
        log.info('Received new UDID: ' + API.UDID);

        self._db.get(':deviceId').then(doc => {
          doc[API.appId] = API.UDID;
          log.warn('Replacing existing UDID');
          self._db.put(doc).catch(err => {
            log.warn('Could not persist UDID. Error: ' + err);
          });
        }).catch(() => {
          let newObject = {
            _id: ':deviceId'
          };

          newObject[API.appId] = API.UDID;
          self._db.put(newObject).catch(err => {
            log.warn('Could not persist UDID. Error: ' + err);
          });
        });
      }
      self._socket.emit('bind_device', {
        'device_id': API.UDID,
        'application_id': API.appId
      });

      log.info('Connection established');
      // On a successful connection, the `connect` event is emitted by the Telepat object.
      // To listen for a connection, use:
      //
      //     Telepat.on('connect', function () {
      //       // Connected
      //     });
      self.getContexts(() => {
        self._updateUser(options.reauth, () => {
          self.currentAppId = API.appId;
          self.connected = true;
          self.connecting = false;
          self._event.emit('connect');
          callback(null, self);
        });
      });
      return true;
    }

    function registerDevice() {
      var request = {
        'info': {
          'os': 'web',
          'userAgent': ((typeof navigator !== 'undefined') ? navigator.userAgent : 'node')
        },
        'volatile': {
          'type': 'sockets',
          'active': 1,
          'token': self._sessionId
        }
      };

      if (self._persistentConnectionOptions) {
        request.persistent = self._persistentConnectionOptions;
        if (request.persistent.active === 1) {
          request.volatile.active = 0;
        }
      }
      API.call('device/register', request, function (err, res) {
        if (err) {
          API.UDID = null;
          API.call('device/register', request, function (err, res) {
            if (err) {
              self._socket.disconnect();
              self._event.emit('disconnect', err);
              self.currentAppId = null;
              self.connected = false;
              self.connecting = false;
              return callback(error('Device registration failed with error: ' + err));
            }
            return completeRegistration(res);
          });
        } else {
          return completeRegistration(res);
        }
      });
    }

    // Required configuration options:
    if (typeof options !== 'undefined') {
      // - `apiKey`: the API key for the application to connect to
      if (typeof options.apiKey === 'undefined') {
        return callback(error('Connect options must provide an apiKey property'));
      }
      // - `appId`: the id of the application to connect to
      if (typeof options.appId === 'undefined') {
        return callback(error('Connect options must provide an appId property'));
      }
      // - `apiEndpoint`: the host and port number for the API service
      if (typeof options.apiEndpoint !== 'undefined') {
        API.apiEndpoint = options.apiEndpoint + '/';
      } else if (!API.apiEndpoint) {
        return callback(error('Connect options must provide an apiEndpoint property, or you must run `configure` first'));
      }
      // - `socketEndpoint`: the host and port number for the socket service
      if (typeof options.socketEndpoint !== 'undefined') {
        this._socketEndpoint = options.socketEndpoint;
      } else if (!this._socketEndpoint) {
        return callback(error('Connect options must provide an socketEndpoint property, or you must run `configure` first'));
      }
      // - `timerInterval`: the time interval in miliseconds between two object-monitoring jobs
      // on channels - defaults to 150
      if (typeof options.timerInterval !== 'undefined') {
        this._monitor.timerInterval = options.timerInterval;
      }
    } else {
      return callback(error('Options object not provided to the connect function'));
    }

    this.connecting = true;

    if (this.connected) {
      this.disconnect();
    }

    API.apiKey = options.apiKey;
    API.appId = options.appId;

    if (this.admin.apps) {
      this.admin.app = this.admin.apps[API.appId];
    }

    this._persistentConnectionOptions = options.persistentConnection || this._persistentConnectionOptions;

    this._socket = require('socket.io-client')(this._socketEndpoint, options.ioOptions || {});
    log.info('Connecting to socket service ' + this._socketEndpoint);

    if (__0_3__) { // eslint-disable-line no-undef
      this._socket.on('welcome', data => {
        this._sessionId = data.sessionId;

        if (options.updateUDID) {
          registerDevice();
        } else {
          this._db.get(':deviceId').then(doc => {
            if (doc[API.appId]) {
              API.UDID = doc[API.appId];
              log.info('Retrieved saved UDID: ' + API.UDID);
            }
            registerDevice();
          }).catch(function () {
            registerDevice();
          });
        }
      });
    } else {
      if (options.updateUDID) {
        registerDevice();
      } else {
        this._db.get(':deviceId').then(doc => {
          if (doc[API.appId]) {
            API.UDID = doc[API.appId];
            log.info('Retrieved saved UDID: ' + API.UDID);
          }
          registerDevice();
        }).catch(function () {
          registerDevice();
        });
      }
    }

    this._socket.on('message', message => {
      this._monitor.processMessage(message);
    });

    this._socket.on('context-update', () => {
      this.getContexts();
    });

    this._socket.on('disconnect', () => {
    });

    return this;
  }

  /**
   * ## Telepat.disconnect
   *
   * You can use this function to disconnect the socket.io transport from the Telepat endpoint.
   *
   */
  disconnect() {
    this._socket.close();
    this._socket = null;
    this._sessionId = null;
    this.contexts = null;
    this._monitor.remove({channel: {model: 'context'}});

    for (var key in this.subscriptions) {
      this.subscriptions[key].unsubscribe();
    }
    this.subscriptions = {};

    if (!this.user.isAdmin) {
      this.user.logout(() => {
        this.admin.unhook();
        this.admin = null;
        this.user = null;
      });
    }

    API.apiKey = null;
    API.appId = null;
    API.UDID = null;

    this._event.emit('disconnect');
    this.currentAppId = null;
    this.connected = false;
  };

  /**
   * ## Telepat.processMessage
   *
   * Forwards messages reveived via external channels to the processing unit.
   *
   * @param {string} message The delta update notification received from Telepat
   */
  processMessage(message) {
    this._monitor.processMessage(message);
  }

  /**
   * ## Telepat.setLogLevel
   *
   * You can tweak the logger verbosity using this function.
   *
   * @param {string} level One of `'debug'`, `'info'`, `'warn'` or `'error'`
   */
  setLogLevel(level) {
    log.setLevel(level);
    return this;
  }

  /**
   * ## Telepat.on
   *
   * Call this function to add callbacks to be invoked on event triggers.
   *
   * @param {string} name The name of the event to associate the callback with
   * @param {function} callback The callback to be executed
   */
  on(name, callback) {
    return this._event.on(name, callback);
  };

  removeCallback(name, index) {
    return this._event.removeCallback(name, index);
  };

  /**
   * ## Telepat.subscribe
   *
   * Use this function to create a new [Channel](http://docs.telepat.io/telepat-js/lib/channel.js.html)
     object and connect it to the backend.
   *
   * You can pass a callback to be invoked on channel subscription. This is equivalent to calling
    `.on('subscribe' ...)` directly on the returned Channel.
   *
   * @param {Object} options The object describing the required subscription (context, channel, filters)
   * @param {function, optional} onSubscribe Callback to be executed on a successful subscribe
   *
   * @return {Channel} The new [Channel](http://docs.telepat.io/telepat-js/lib/channel.js.html) object
   */
  subscribe(options, onSubscribe) {
    let channel = new Channel(this._monitor, options);
    let key = Monitor.subscriptionKeyForOptions(options);

    this.subscriptions[key] = channel;
    channel.subscribe();
    if (onSubscribe !== undefined) {
      channel.on('subscribe', onSubscribe);
    }
    channel.on('_unsubscribe', () => {
      delete this.subscriptions[key];
    });
    return channel;
  };

  getChannel(options) {
    let key = Monitor.subscriptionKeyForOptions(options);

    if (this.subscriptions[key]) {
      return this.subscriptions[key];
    }
    return new Channel(this._monitor, options);
  }

  sendEmail(from, fromName, to, subject, body, callback) {
    API.call('/email', {
      'recipients': to,
      'from': from,
      'from_name': fromName,
      'subject': subject,
      'body': body
    }, (err, res) => {
      if (err) {
        callback(error('Send email failed with error: ' + err), null);
      } else {
        callback(null, res.body.content);
      }
    });
  };

  get(options, callback) {
    options['no_subscribe'] = true;
    API.call('object/subscribe',
    options,
    (err, res) => {
      if (err) {
        this._event.emit('error', error('Get objects failed with error: ' + err));
        callback(error('Get objects failed with error: ' + err), null);
      } else {
        callback(null, res.body.content);
      }
    });
  }
};
