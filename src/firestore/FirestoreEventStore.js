'use strict'

const IEventStore = require('../IEventStore')
const ITracer = require('../ITracer')
const Aggregate = require('../Aggregate')
const PromiseQueue = require('../PromiseQueue')
const Err = require('../Err')

function aggregatesPath (tenant, aggregateType) {
  return '/tenants/'.concat(tenant, aggregateType.path)
}

function streamPath (tenant, stream) {
  return '/tenants/'.concat(tenant, '/streams/', stream)
}

class Padder {
  constructor (max = 1e6) {
    this.padLen = (max - 1).toString().length
    if (this.padLen > 6) throw Err.preconditionError('max events is higher than 1000000')
    this.padStr = '000000'.substr(0, this.padLen)
  }

  pad (number) {
    const s = number.toString()
    return this.padStr.substr(0, this.padLen - s.length).concat(s)
  }
}

module.exports = class FirestoreEventStore extends IEventStore {
  constructor (db, snapshots = true, tracer = null) {
    super()
    this._db_ = db
    this._snapshots_ = snapshots || false
    this._tracer_ = tracer || new ITracer()
    this._commitQueue_ = new PromiseQueue()
  }

  async loadAggregate (tenant, aggregateType, aggregateId) {
    if (aggregateId) {
      const doc = this._snapshots_ ? await this._db_.collection(aggregatesPath(tenant, aggregateType)).doc(aggregateId).get() : null
      const aggregate = Aggregate.create(aggregateType, doc && doc.exists ? doc.data() : { _aggregate_id_: aggregateId })
      
      // load events that ocurred after snapshot was taken
      const aggregateVersionPadder = new Padder(aggregateType.maxEvents)
      const versionPadded = aggregateVersionPadder.pad(aggregate.aggregateVersion + 1)
      const eventsRef = this._db_.collection(streamPath(tenant, aggregateType.stream).concat('/events'))
      const events = await eventsRef
        .where('_t', '==', aggregateType.name)
        .where('_a', '==', aggregate.aggregateId)
        .where('_v', '>=', versionPadded).get()
      events.forEach(doc => {
        const event = Object.freeze(doc.data())
        aggregate._loadEvent(event)
        this._tracer_.trace(() => ({ stat: 'loadEvent', aggregateType, event }))
      })
      return aggregate
    }
    // return new aggregate with generated id
    const newAggRef = this._db_.collection(aggregatesPath(tenant, aggregateType)).doc()
    return Aggregate.create(aggregateType, { _aggregate_id_: newAggRef.id })
  }

  async commitEvents (actor, command, aggregate, expectedVersion) {
    if (aggregate.aggregateVersion !== expectedVersion) throw Err.concurrencyError()
    const commit = async ({ actor, command, aggregate, expectedVersion }) => {
      const aggregateType = Object.getPrototypeOf(aggregate).constructor
      if (expectedVersion + 1 >= aggregateType.maxEvents - 1) throw Err.preconditionError('max events reached')
      
      const eventsVersionPadder = new Padder()
      const aggregateVersionPadder = new Padder(aggregateType.maxEvents)
      const aggregateRef = this._db_.collection(aggregatesPath(actor.tenant, aggregateType)).doc(aggregate.aggregateId)
      const streamRef = this._db_.doc(streamPath(actor.tenant, aggregateType.stream))
      const eventsRef = streamRef.collection('events')
      return await this._db_.runTransaction(async transaction => {
        const events = []

        // get stream version
        const streamDoc = await transaction.get(streamRef)
        const streamData = streamDoc.data()
        let version = (streamData && typeof streamData._version_ !== 'undefined') ? streamData._version_ : -1
        
        // check aggregate version
        const paddedExpectedVersion = aggregateVersionPadder.pad(expectedVersion)
        const check = await eventsRef
          .where('_t', '==', aggregateType.name)
          .where('_a', '==', aggregate.aggregateId)
          .where('_v', '>', paddedExpectedVersion).limit(1).get()
        if (!check.empty) throw Err.concurrencyError()

        for(let event of aggregate._uncommitted_events_) {
          const eventId = eventsVersionPadder.pad(++version)
          const eventObject = Object.assign({
            _u: actor.id,
            _c: command,
            _t: aggregateType.name,
            _a: aggregate._aggregate_id_,
            _v: aggregateVersionPadder.pad(++expectedVersion),
            _version_: version
          }, event)
          await transaction.set(eventsRef.doc(eventId), eventObject)
          events.push(eventObject)
        }
        await transaction.set(streamRef, { _version_: version }, { merge: true })
        aggregate._aggregate_version_ = expectedVersion
        if (this._snapshots_) await transaction.set(aggregateRef, aggregate.clone())
        return events
      })
    }
    return await this._commitQueue_.push(commit, { actor, command, aggregate, expectedVersion })
  }
}
