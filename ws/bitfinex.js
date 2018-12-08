'use strict'

const EventEmitter = require('events');
const WebSocket = require('ws');
const debug = require('debug')('bitfinex:ws')

const WS_URL = 'wss://api.bitfinex.com/ws/'

const isSnapshot = msg => msg[0] && Array.isArray(msg[0]);
/**
 * Communicates with v1 of the Bitfinex WebSocket API
 */
class WSv1 extends EventEmitter {
    /**
     * @param {sting} opts.apiKey
     * @param {string} opts.apiSecret
     * @param {string} opts.url - ws connection url
     */
    constructor(opts = { apiKey: '', apiSecret: '', url: WS_URL }) {
        super()

        this._apiKey = opts.apiKey || ''
        this._apiSecret = opts.apiSecret || ''
        this._url = opts.url || WS_URL
        this._agent = opts.agent
        this._channelMap = {} // map channel IDs to events

        this.pongTime
    }

    open() {
        this._ws = new WebSocket(this._url, {
            agent: this._agent
        })

        this._ws.on('message', this._onWSMessage.bind(this))
        this._ws.on('open', this._onWSOpen.bind(this))
        this._ws.on('error', this._onWSError.bind(this))
        this._ws.on('close', this._onWSClose.bind(this))
    }

    _onWSMessage(msgJSON, flags) {
        let msg

        try {
            msg = JSON.parse(msgJSON)
        } catch (e) {
            debug('[bfx ws2 error] received invalid json')
            debug('[bfx ws2 error] ', msgJSON)
            return
        }

        //debug('Received message: ', msg)
        this.emit('message', msg, flags);
        //debug('Emmited message event')

        // Drop out early if channel data
        if (Array.isArray(msg) || !msg.event) {
            return this._handleChannel(msg)
        }

        if (msg.event === 'subscribed') {
            debug('Subscription report received')
            this._channelMap[msg.chanId] = msg
        } else if (msg.event === 'auth') {
            if (msg.status !== 'OK') {
                debug('Emitting \'error\' ', msg)
                this.emit('error', msg)
                return
            }

            this._channelMap[msg.chanId] = { channel: 'auth' }
        } else if (msg.event === 'pong') {
            debug('Received pong')
            this.pongTime = new Date().getTime();
            return
        }

        debug('Emitting \'%s\' ', msg.event, msg)
        this.emit(msg.event, msg)
    }

    _handleChannel(msg) {
        try {
            // First element of Array is the channelId, the rest is the info.
            const channelId = msg.shift() // Pop the first element
            const event = this._channelMap[channelId]

            if (msg[0] === 'hb') {
                return; // debug(`received heartbeat in ${event.channel}`)
            }

            if (event) {
                //debug('Message in \'%s\' channel', event.channel)

                if (event.channel === 'book') {
                    this._processBookEvent(msg, event)
                } else if (event.channel === 'trades') {
                    this._processTradeEvent(msg, event)
                } else if (event.channel === 'ticker') {
                    this._processTickerEvent(msg, event)
                } else if (event.channel === 'auth') {
                    this._processUserEvent(msg)
                } else {
                    debug('Message in unknown channel')
                }
            }
        } catch (error) {
            debug(error);
        }
    }

    _processUserEvent(msg) {
        const event = msg[0]
        const data = msg[1]

        if (Array.isArray(data[0])) {
            data[0].forEach((ele) => {
                debug('Emitting \'%s\' ', event, ele)
                this.emit(event, ele)
            })
        } else if (data.length) {
            debug('Emitting \'%s\', ', event, data)
            this.emit(event, data)
        }
    }

    _processTickerEvent(msg, event) {
        try {
            if (msg.length > 9) { // Update
                // All values are numbers
                const update = {
                    bid: msg[0],
                    bidSize: msg[1],
                    ask: msg[2],
                    askSize: msg[3],
                    dailyChange: msg[4],
                    dailyChangePerc: msg[5],
                    lastPrice: msg[6],
                    volume: msg[7],
                    high: msg[8],
                    low: msg[9]
                }
    
                debug('Emitting ticker, %s, ', event.pair, update)
                this.emit('ticker', event.pair, update)
            }
            
        } catch (error) {
            debug(error);
        }
    }

    _processTradeEvent(msg, event) {
        try {
            if (isSnapshot(msg)) {
                const snapshot = msg[0].map(el => ({
                    seq: el[0],
                    timestamp: el[1],
                    price: el[2],
                    amount: Math.abs(el[3]),
                    type: el[3] < 0 ? 'ask' : 'bid'
                }))
    
                debug('Emitting trade snapshot, %s, ', event.pair, snapshot);
                //要最新的交易数据，第一次全量的不要
                //this.emit('trade', event.pair, snapshot)
                return
            }
    
            //if (msg[0] !== 'te' && msg[0] !== 'tu') return
            //只取te
            if (msg[0] !== 'te') return
    
            // seq is a string, other payload members are nums
            const update = { seq: msg[1] }
    
            if (msg[0] === 'te') { // Trade executed
                update.timestamp = msg[2]
                update.price = msg[3]
                update.amount = Math.abs(msg[4])
                update.type = msg[4] < 0 ? 'ask' : 'bid'
            } else { // Trade updated
                update.id = msg[2]
                update.timestamp = msg[3]
                update.price = msg[4]
                update.amount = msg[5]
                update.type = msg[5] < 0 ? 'ask' : 'bid'
            }
    
            // See http://docs.bitfinex.com/#trades75
            //debug('Emitting trade', event.pair, update)
            this.emit('trade', event.pair, [update])
            
        } catch (error) {
            debug(error);
        }
    }

    _processBookEvent(msg, event) {
        try {
            // TODO: Maybe break this up into snapshot/normal handlers? Also trade event
            if (!isSnapshot(msg[0]) && msg.length > 2) {
                let depth
    
                let update = { asks: [], bids: [] };
                if (event.prec === 'R0') {
                    depth = {
                        price: msg[1],
                        orderId: msg[0],
                        amount: msg[2]
                    }
                } else {
                    depth = {
                        price: msg[0],
                        count: msg[1],
                        amount: msg[2]
                    }
                }
    
                if (depth.amount < 0) {
                    depth.amount *= -1;
                    update.asks.push(depth);
                } else {
                    update.bids.push(depth);
                }
    
                //debug('Emitting orderbook, %s, ', event.pair, update)
                this.emit('orderbook', event.pair, update)
                return
            }
    
            msg = msg[0]
    
            if (isSnapshot(msg)) {
                const snapshot = msg.map((el) => {
                    if (event.prec === 'R0') {
                        return {
                            orderId: el[0],
                            price: el[1],
                            amount: el[2]
                        }
                    }
    
                    return {
                        price: el[0],
                        count: el[1],
                        amount: el[2]
                    }
                })
    
                let depth = { asks: [], bids: [] };
                (snapshot).forEach(element => {
                    if (element.amount < 0) {
                        element.amount *= -1;
                        depth.asks.push(element);
                    } else {
                        depth.bids.push(element);
                    }
                });
                //debug('Emitting orderbook snapshot, %s, ', event.pair, depth)
                this.emit('orderbook', event.pair, depth)
            }
        } catch (error) {
            debug(error);
        }
    }

    close() {
        if (this.hb) {
            clearInterval(this.hb);
            this.hb = null;
        }
        this._ws.close()
    }

    _onWSOpen() {
        this._channelMap = {}
        this.sendHeartBeat()
        this.monitorConnectStatus();
        this.emit('open')
    }

    _onWSError(error) {
        this.emit('error', error)
    }

    _onWSClose() {
        if (this.hb) {
            clearInterval(this.hb);
            this.hb = null;
        }
        this.emit('close')
    }

    send(msg) {
        debug('Sending ', msg)
        try {
            this._ws.send(JSON.stringify(msg))
        } catch (error) {
            debug('Sending error ', error)
        }
    }

    /**
     * Subscribe to order book updates. Snapshot will be sent as multiple updates.
     * Event will be emited as `PAIRNAME_book`.
     *
     * @param {string} pair - BTCUSD, LTCUSD or LTCBTC. Default BTCUSD
     * @param {string} precision - price aggregation level (P0 (def), P1, P2, P3)
     * @param {string} length - number of price points. 25 (default) or 100.
     * @see http://docs.bitfinex.com/#order-books
     */
    subscribeOrderBook(pair = 'BTCUSD', len = '100', prec = 'P0') {
        this.send({
            event: 'subscribe',
            channel: 'book',
            pair,
            prec,
            len
        })
    }

    // unsubscribeOrderBook(pair = 'btc_usdt') {
    //     let channel = Object.values(this._channelMap).find((item) => {
    //         return item.channel == 'book' && item.pair == pair;
    //     });
    //     if (channel) {
    //         this.unsubscribe(channel.chanId);
    //         delete this._channelMap[channel.chanId];
    //     }
    // }

    /**
     * Subscribe to trades. Snapshot will be sent as multiple updates.
     * Event will be emited as `PAIRNAME_trades`.
     *
     * @param {string} pair - BTCUSD, LTCUSD or LTCBTC. Default BTCUSD
     * @see http://docs.bitfinex.com/#trades75
     */
    subscribeTrades(pair = 'BTCUSD') {
        this.send({
            event: 'subscribe',
            channel: 'trades',
            pair
        })
    }

    /**
     * Subscribe to ticker updates. The ticker is a high level overview of the
     * state of the market. It shows you the current best bid and ask, as well as
     * the last trade price.
     *
     * Event will be emited as `PAIRNAME_ticker`.
     *
     * @param {string} - pair BTCUSD, LTCUSD or LTCBTC. Default BTCUSD
     * @see http://docs.bitfinex.com/#ticker76
     */
    subscribeTicker(pair = 'BTCUSD') {
        this.send({
            event: 'subscribe',
            channel: 'ticker',
            pair
        })
    }

    /**
     * Unsubscribe from a channel.
     *
     * @param {number} chanId - ID of the channel received on `subscribed` event
     */
    unsubscribe(chanId) {
        this.send({
            event: 'unsubscribe',
            chanId
        })
    }

    sendHeartBeat() {
        this.hb = setInterval(() => {
            this.send({
                event: 'ping'
            })
        }, 20000);
    }

    monitorConnectStatus() {
        if (this.monitorCS) {
            clearInterval(this.monitorCS);
            this.monitorCS = null;
        }
        this.monitorCS = setInterval(() => {
            let now = new Date().getTime();
            //20s ping一次，如果长时间未收到pong, 断开重连
            if (now - this.pongTime > 1000 * 60) {
                this._onWSClose();
            }
        }, 1000 * 60)
    }
}

module.exports = WSv1;