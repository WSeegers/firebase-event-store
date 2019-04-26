'use strict'

const { setup, firebase, ITracer } = require('../setup')
const { Calculator, EventCounter } = require('./model')

let bus, firestore, stream, handlers

const actor1 = { id: 'user1', name: 'user1', tenant: 'tenant1', roles: [] }

class ConsoleTracer extends ITracer {
  constructor () {
    super()
  }

  trace (fn) {
    const { method, context, tenant, stream, events, handler, error, event, ...args } = fn()
    if (error) {
      console.log(`!!! ERROR: ${error}`)
    }
    if (context) console.log(`  ${method}: ${JSON.stringify(context)}`)
    if (handler) console.log(`  ${handler}: handled ${JSON.stringify(event)} on tenant ${tenant} - stream ${stream}`)
  }
}

describe('Streams', () => {
  before (async () => {
    bus = setup([Calculator], true, new ConsoleTracer())
    firestore = firebase.firestore()
    firestore.children = []
    handlers = [new EventCounter(firestore, 'counter11')]
  })

  it('should catch up counter2 in current window', async () => {
    let calc
    calc = await bus.command(actor1, 'AddNumbers', { number1: 1, number2: 2, aggregateId: 'c1222' })
    calc = await bus.command(actor1, 'AddNumbers', { number1: 3, number2: 4, aggregateId: calc.aggregateId })
    calc = await bus.command(actor1, 'AddNumbers', { number1: 1, number2: 1, aggregateId: calc.aggregateId })
    let pending = await bus.poll('tenant1', 'main', handlers)
    let counter1 = await firestore.doc('/counters/counter11').get()
    counter1.data().eventCount.should.equal(3)
    
    handlers = [new EventCounter(firestore, 'counter11'), new EventCounter(firestore, 'counter21')]
    calc = await bus.command(actor1, 'AddNumbers', { number1: 1, number2: 2, aggregateId: 'c1222' })
    calc = await bus.command(actor1, 'AddNumbers', { number1: 3, number2: 4, aggregateId: calc.aggregateId })
    calc = await bus.command(actor1, 'AddNumbers', { number1: 1, number2: 1, aggregateId: calc.aggregateId })
    pending = await bus.poll('tenant1', 'main', handlers)
    counter1 = await firestore.doc('/counters/counter11').get()
    counter1.data().eventCount.should.equal(6)
    let counter2 = await firestore.doc('/counters/counter21').get()
    counter2.data().eventCount.should.equal(6)
  })

  it('should catch up counting with catchup window', async () => {
    let calc
    calc = await bus.command(actor1, 'AddNumbers', { number1: 1, number2: 2, aggregateId: 'cxz' })
    calc = await bus.command(actor1, 'AddNumbers', { number1: 3, number2: 4, aggregateId: calc.aggregateId })
    calc = await bus.command(actor1, 'AddNumbers', { number1: 1, number2: 1, aggregateId: calc.aggregateId })
    await bus.poll('tenant1', 'main', handlers)
    
    handlers = [new EventCounter(firestore, 'counter11'), new EventCounter(firestore, 'counter21'), new EventCounter(firestore, 'counter31')]
    calc = await bus.command(actor1, 'AddNumbers', { number1: 1, number2: 2, aggregateId: 'cxz' })
    calc = await bus.command(actor1, 'AddNumbers', { number1: 3, number2: 4, aggregateId: calc.aggregateId })
    calc = await bus.command(actor1, 'AddNumbers', { number1: 1, number2: 1, aggregateId: calc.aggregateId })
    await bus.poll('tenant1', 'main', handlers, { limit: 5 })
    await bus.poll('tenant1', 'main', handlers, { limit: 5 })
    await bus.poll('tenant1', 'main', handlers, { limit: 5 })
    let counter1 = await firestore.doc('/counters/counter11').get()
    counter1.data().eventCount.should.equal(12)
    let counter2 = await firestore.doc('/counters/counter21').get()
    counter2.data().eventCount.should.equal(12)
    let counter3 = await firestore.doc('/counters/counter31').get()
    counter3.data().eventCount.should.equal(12)
  })

  it('should catch up counting with catchup window 2', async () => {
    let calc
    calc = await bus.command(actor1, 'AddNumbers', { number1: 1, number2: 2, aggregateId: 'cxz' })
    handlers = [new EventCounter(firestore, 'counter41')]
    calc = await bus.command(actor1, 'AddNumbers', { number1: 1, number2: 2, aggregateId: 'cxz' })
    await bus.poll('tenant1', 'main', handlers, { limit: 5 })
    await bus.poll('tenant1', 'main', handlers, { limit: 5 })
    await bus.poll('tenant1', 'main', handlers, { limit: 5 })
    let counter4 = await firestore.doc('/counters/counter41').get()
    counter4.data().eventCount.should.equal(14)
  })

  it('should catch up counting in parallel', async () => {
    await bus.command(actor1, 'AddNumbers', { number1: 1, number2: 2, aggregateId: 'cxz' })
    let bus2 = setup([Calculator])
    handlers = [new EventCounter(firestore, 'counter51')]
    let handlers2 = [new EventCounter(firestore, 'counter61')]
    await bus2.command(actor1, 'AddNumbers', { number1: 1, number2: 2, aggregateId: 'cxz' })
    await bus.command(actor1, 'AddNumbers', { number1: 1, number2: 2, aggregateId: 'cxz' })
    await bus.poll('tenant1', 'main', handlers, { limit: 7 })
    await bus.poll('tenant1', 'main', handlers, { limit: 7 })
    await bus.poll('tenant1', 'main', handlers, { limit: 7 })
    let main = await firestore.doc('/tenants/tenant1/streams/main').get()
    console.log(JSON.stringify(main.data()))
    await bus.poll('tenant1', 'main', handlers, { limit: 7 })
    main = await firestore.doc('/tenants/tenant1/streams/main').get()
    console.log(JSON.stringify(main.data()))

    await bus.poll('tenant1', 'main', handlers2, { limit: 8 })
    await bus.poll('tenant1', 'main', handlers2, { limit: 8 })
    await bus.poll('tenant1', 'main', handlers2, { limit: 8 })

    main = await firestore.doc('/tenants/tenant1/streams/main').get()
    console.log(JSON.stringify(main.data()))
    let counter5 = await firestore.doc('/counters/counter51').get()
    counter5.data().eventCount.should.equal(17)
    let counter6 = await firestore.doc('/counters/counter61').get()
    counter6.data().eventCount.should.equal(17)
  })

  it('should poll until done', async () => {
    handlers = [new EventCounter(firestore, 'counter71')]
    await bus.poll('tenant1', 'main', handlers, { limit: 20 })
    await bus.command(actor1, 'AddNumbers', { number1: 1, number2: 2, aggregateId: 'cxz' })
    await bus.poll('tenant1', 'main', handlers)
    let counter7 = await firestore.doc('/counters/counter71').get()
    counter7.data().eventCount.should.equal(18)
  })
})
