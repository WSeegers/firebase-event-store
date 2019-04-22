'use strict'

const Aggregate = require('./Aggregate')
const ITracer = require('./ITracer')
const IEventStore = require('./IEventStore')
const IEventHandler = require('./IEventHandler')
const Err = require('./Err')

class CommandMapper {
  constructor (aggregates) {
    this._map_ = {}
    aggregates.forEach(aggregateType => {
      if (!(aggregateType.prototype instanceof Aggregate)) throw Err.preconditionError(`${aggregateType.name} is not a subclass of Aggregate`)
      const aggregate = Aggregate.create(aggregateType)
      for(let command of Object.keys(aggregate.commands)) {
        this._map_[command] = aggregateType
      }
    })
  }

  map (command) {
    const aggregateType = this._map_[command]
    if (!aggregateType) throw Err.invalidArguments(`command ${command} not found`)
    return aggregateType
  }
}

class Cache {
  constructor(size = 10) {
    this._size_ = size
    this._cache_ = new Map()
  }

  get (key) {
    if (!this._size_) return null

    const item = this._cache_.get(key)
    if (item) {
      this._cache_.delete(key)
      this._cache_.set(key, item)
    }
    return item
  }

  set (key, item) {
    if (!this._size_) return

    if (this._cache_.has(key)) this._cache_.delete(key)
    this._cache_.set(key, item)

    while (this._cache_.size > this._size_) {
      const first = this._cache_.keys().next().value
      this._cache_.delete(first)
    }
  }
}

/**
 * Message Bus
 */
module.exports = class Bus {
  /**
   * Bus constructor
   * 
   * @param {IEventStore} store The event store
   * @param {Aggregate[]} aggregates Array of aggregates supported by this instance
   * @param {ITracer} tracer Tracer module
   * @param {Integer} CACHE_SIZE Size of aggregate cache
   */
  constructor (store, aggregates, tracer = null, CACHE_SIZE = 10) {
    if (!(store instanceof IEventStore)) throw Err.invalidArguments('store')
    if (tracer && !(tracer instanceof ITracer)) throw Err.invalidArguments('tracer')
    this._store_ = store
    this._tracer_ = tracer || new ITracer()
    this._mapper_ = new CommandMapper(aggregates)
    this._cache_ = new Cache(CACHE_SIZE)
    this._streams_ = {}
  }

  /**
   * Command Handler
   * 
   * @param {Object} actor User/Process sending command - must contain { id, name, tenant, and roles }
   * @param {String} command name
   * @param {Object} payload including aggregateId and expectedVersion
   * @returns {Aggregate} aggregate
   */
  async command (actor, command, { aggregateId = '', expectedVersion = -1, ...payload } = {}) {
    // validate arguments
    if (!actor) throw Err.missingArguments('actor')
    if (!actor.id) throw Err.missingArguments('actor.id')
    if (!actor.name) throw Err.missingArguments('actor.name')
    if (!actor.tenant) throw Err.missingArguments('actor.tenant')
    if (!actor.roles) throw Err.missingArguments('actor.roles')
    if (!command) throw Err.missingArguments('command')
    
    // get aggregate type from commands map
    if (expectedVersion >= 0 && !aggregateId) throw Err.missingArguments('aggregateId')

    const aggregateType = this._mapper_.map(command)
    this._tracer_.trace(() => ({ method: 'command', actor, command, aggregateId, expectedVersion, payload }))

    // load aggregate
    let aggregate

    // try cache first
    const key = aggregateType.name.concat('.', aggregateId)
    if (aggregateId && expectedVersion >= 0) {
      const copy = this._cache_.get(key)
      if (copy) aggregate = Aggregate.create(aggregateType, copy)
    }

    // load from store if not found in cache or incorrect version
    if (!(aggregate && aggregate._aggregate_version_ === expectedVersion)) {
      aggregate = await this._store_.loadAggregate(actor.tenant, aggregateType, aggregateId)
      this._tracer_.trace(() => ({ method: 'loadAggregate', aggregate, aggregateType }))
    }
  
    // handle command
    await aggregate.commands[command](actor, payload, this)

    if (aggregate._uncommitted_events_.length) {
      // assume user wants to act on latest version when not provided
      if (expectedVersion === -1) expectedVersion = aggregate._aggregate_version_

      // commit events
      const events = await this._store_.commitEvents(actor, command, aggregate, expectedVersion)
      this._tracer_.trace(() => ({ method: 'commitEvents', events, actor, command, aggregate, aggregateType }))

      // cache aggregate
      this._cache_.set(key, aggregate.clone())
    }

    return aggregate
  }

  /**
   * Subscribes event handlers with bus
   * New handlers catch up while current handlers keep receiving new events
   * in real time
   * @param {IEventStream[]} streams Array of event streams
   * @param {IEventHandler[]} handlers Array of event handlers
   */
  async subscribe (streams, handlers) {
    for (let stream of streams) {
      for (let handler of handlers) {
        if (handler instanceof IEventHandler && stream._name_ === handler.stream) await stream.subscribe(handler)
      }
      this._streams_[stream._tenant_] = this._streams_[stream._tenant_] || {}
      this._streams_[stream._tenant_][stream._name_] = stream
      stream.catchup()
    }
  }

  /**
   * Pushes event to stream
   * @param {String} tenant Tenant id
   * @param {String} stream Stream name
   * @param {Object} event Event object
   * @param {Boolean} load True to load window
   */
  async push (tenant, stream, event = null, load = false) {
    const streams = this._streams_[tenant]
    if (streams) {
      const s = streams[stream]
      if (s) s.push(event, load)
    }
  }

  /**
   * Polls stream for new events to push
   * 
   * @param {String} tenant Tenant id
   * @param {String} stream Stream name
   */
  async poll (tenant, stream = 'main') {
    await this.push(tenant, stream, null, true)
  }

  /**
   * Flushes tenant by waiting for pending pushes
   * 
   * @param {String} tenant Tenant Id
   */
  async flush (tenant) {
    const streams = this._streams_[tenant]
    if (streams) {
      for (let stream of Object.values(streams)) {
        await stream.flush()
      }
    }
  }
}
