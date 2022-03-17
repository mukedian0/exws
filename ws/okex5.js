'use strict'
const EventEmitter = require('events');
const WebSocket = require('ws');
const debug = require('debug')('okex:ws3')
const pako = require('pako');

const WS_URL = 'wss://ws.okx.com:8443/ws/v5/public'
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
            msg = JSON.parse(msgJSON);
        } catch (e) {
            debug('[okex ws3 error] received invalid json')
            debug('[okex ws3 error]  ', msgJSON)
            return
        }
        //debug('Received message:  ', msg)
        this.emit('message', msg, flags);
        //debug('Emmited message event')

        // Drop out early if channel data
        if (msg === 'pong') {
            debug('Received pong')
            this.pongTime = new Date().getTime();
            return
        }
        if (msg.event){
            if(msg.event === 'subscribe'){
                debug('Subscription report received')
                let channel = `${msg.arg.channel}:${msg.arg.instId}`;
                this._channelMap[channel].connect = true;
            } 
        }
        if (msg.arg) {
            return this._handleChannel(msg)
        }

        debug('Emitting \'%s\'  ', msg.event, msg)
        this.emit(msg.event, msg)
    }

    _handleChannel(msg) {
        try {
            let arg = msg.arg
            let channel = `${arg.channel}:${arg.instId}`;
            const event = this._channelMap[channel]

            if (event) {
                //debug('Message in \'%s\' channel', event.channel)

                if (event.channel === 'books') {
                    this._processBookEvent(msg.data, event)
                } else if (event.channel === 'trades') {
                    this._processTradeEvent(msg.data, event)
                } else if (event.channel === 'tickers') {
                    this._processTickerEvent(msg.data, event)
                } else {
                    debug('Message in unknown channel')
                }
            }
        } catch (error) {
            debug(error);
        }
    }

    _processTickerEvent(data, event) {
        try {
            // All values are numbers
            let msg = data[0]
            const update = {
                bid: msg.bidPx,
                ask: msg.askPx,
                lastPrice: msg.last,
                volume: msg.vol24h,
                high: msg.high24h,
                low: msg.low24h
            }

            debug('Emitting ticker, %s,  ', event.pair, update)
            this.emit('ticker', event.pair, update)
        } catch (error) {
            debug(error);
        }
    }

    _processTradeEvent(msg, event) {
        try {
            if (msg.length == 60) {
                //要最新的交易数据，第一次全量的不要
                return;
            }
            const trades = msg.map(el => {
                return {
                    seq: el.tradeId,
                    price: el.px,
                    amount: el.sz,
                    timestamp: el.ts,
                    type: el.side === 'sell' ? 'ask' : 'bid'
                }
            })
    
            // See http://docs.bitfinex.com/#trades75
            //debug('Emitting trade, %s,  ', event.pair, trades)
            this.emit('trade', event.pair, trades)
        } catch (error) {
            debug(error);
        }
    }

    _processBookEvent(data, event) {
        // TODO: Maybe break this up into snapshot/normal handlers? Also trade event
        try {
            let update = {};
            let msg = data[0];
            if (msg.asks) {
                const asks = msg.asks.map((el) => {
                    return {
                        price: el[0],
                        amount: el[1],
                        count: el[1], //Okex是0表示刪除，統一用count來判斷是非刪除
                    }
                })
                update.asks = asks;
            }
            if (msg.bids) {
                const bids = msg.bids.map((el) => {
                    return {
                        price: el[0],
                        amount: el[1],
                        count: el[1], //Okex是0表示刪除，統一用count來判斷是非刪除
                    }
                })
                update.bids = bids;
            }
            update.checksum = msg.checksum;
            this.emit('orderbook', event.pair, update);
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
        this.sendHeartBeat();
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
        debug('Sending  ', msg)
        try {
            this._ws.send(JSON.stringify(msg))
        } catch (error) {
            debug('Sending error  ', msg)
        }
    }

    /**
     * Subscribe to order book updates. Snapshot will be sent as multiple updates.
     * Event will be emited as `PAIRNAME_book`.
     *
     * @param {string} pair - btc_usdt, ltc_usdt or ltc_btc .... Default btc_usdt
     * @param {string} length - number of price points. 25 (default) or 100.
     */
    subscribeOrderBook(pair = 'btc_usdt', len) {
        let channelPair = pair.replace("_", "-");
        channelPair = channelPair.toUpperCase();
        let channel = "books"
        this.subscribe(channel, channelPair)
        let key = `${channel}:${channelPair}`
        this._channelMap[key] = {
            channel: channel,
            pair: pair,
            len: len,
            connect: false,
        }
    }

    unsubscribeOrderBook(pair = 'btc_usdt', len) {
        let channelPair = pair.replace("_", "-");
        channelPair = channelPair.toUpperCase();
        let channel = "books"
        let key = `${channel}:${channelPair}`
        if (this._channelMap[key]) {
            this.unsubscribe(channel, channelPair);
            delete this._channelMap[channel];
        }
    }

    /**
     * Subscribe to trades. Snapshot will be sent as multiple updates.
     * Event will be emited as `PAIRNAME_trades`.
     *
     * @param {string} pair - btc_usdt, ltc_usdt or ltc_btc .... Default btc_usdt
     */
    subscribeTrades(pair = 'btc_usdt') {
        let channelPair = pair.replace("_", "-");
        channelPair = channelPair.toUpperCase();
        let channel = "trades"
        this.subscribe(channel, channelPair)
        let key = `${channel}:${channelPair}`
        this._channelMap[key] = {
            channel: 'trades',
            pair: pair,
            connect: false,
        }
    }

    /**
     * Subscribe to ticker updates. The ticker is a high level overview of the
     * state of the market. It shows you the current best bid and ask, as well as
     * the last trade price.
     *
     * Event will be emited as `PAIRNAME_ticker`.
     *
     * @param {string} pair - btc_usdt, ltc_usdt or ltc_btc .... Default btc_usdt
     */
    subscribeTicker(pair = 'btc_usdt') {
        let channelPair = pair.replace("_", "-");
        channelPair = channelPair.toUpperCase();
        let channel = "tickers"
        this.subscribe(channel, channelPair)
        let key = `${channel}:${channelPair}`
        this._channelMap[key] = {
            channel: channel,
            pair: pair,
            connect: false,
        }
    }

    subscribe(channel,pair) {
        this.send({
            op: 'subscribe',
            args: [
                {
                "channel":channel,
                "instId":pair
                }
            ]
        })
    }
    /**
     * Unsubscribe from a channel.
     *
     * @param {number} chanId - ID of the channel received on `subscribed` event
     */
    unsubscribe(channel,pair) {
        this.send({
            op: 'unsubscribe',
            args: [
                {
                    "channel":channel,
                    "instId":pair
                }
            ]
        })
    }

    sendHeartBeat() {
        if (this.hb) {
            clearInterval(this.hb);
            this.hb = null;
        }
        this.hb = setInterval(() => {
            this._ws.send('ping')
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