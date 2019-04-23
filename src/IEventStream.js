'use strict'

const ITracer = require('./ITracer')

module.exports = class IEventStream {
  constructor (tenant, name, tracer = null) {
    this._tenant_ = tenant
    this._name_ = name
    this._tracer_ = tracer || new ITracer()
  }

  /**
   * Poll, handle events, and commits cursors
   * @param {Array} handlers Array of event handlers
   * @param {Integer} limit Max number of events to poll
   * @returns True if any of the handlers is behind
   */
  async poll (handlers, limit = 10) { throw Err.notImplemented('poll') }
}