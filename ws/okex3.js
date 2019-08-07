'use strict'
const EventEmitter = require('events');
const WebSocket = require('ws');
const debug = require('debug')('gateio:ws2')
const pako = require('pako');

const WS_URL = 'wss://real.okex.com:10442/ws/v3'
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
        if (msgJSON instanceof String) {
            msg = msgJSON;
        } else {
            try {
              msg =pako.inflateRaw(msgJSON, {to: 'string'});
            } catch (err) {
              console.log(err)
            }
        }
          
        try {
            msg = JSON.parse(msg);
        } catch (e) {
            debug('[okex ws3 error] received invalid json')
            debug('[okex ws3 error]  ', msgJSON)
            return
        }
        //debug('Received message:  ', msg)
        this.emit('message', msg, flags);
        //debug('Emmited message event')

        // Drop out early if channel data
        if (msg.event){
            if(msg.event === 'subscribe'){
                debug('Subscription report received')
                this._channelMap[msg.channel].connect = true;
            } else if (msg.event === 'pong') {
                debug('Received pong')
                this.pongTime = new Date().getTime();
            }
            return
        }
        
        if (msg.table) {
            return this._handleChannel(msg)
        }

        debug('Emitting \'%s\'  ', msg.event, msg)
        this.emit(msg.event, msg)
    }

    _handleChannel(msg) {
        try {
            let channel = `${msg.table}:${msg.data[0].instrument_id}`;
            const event = this._channelMap[channel]

            if (event) {
                //debug('Message in \'%s\' channel', event.channel)

                if (event.channel === 'book') {
                    this._processBookEvent(msg.data, event)
                } else if (event.channel === 'trades') {
                    this._processTradeEvent(msg.data, event)
                } else if (event.channel === 'ticker') {
                    this._processTickerEvent(msg.data, event)
                } else if (event.channel === 'auth') {
                    this._processUserEvent(msg.data)
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
                debug('Emitting \'%s\'  ', event, ele)
                this.emit(event, ele)
            })
        } else if (data.length) {
            debug('Emitting \'%s\',  ', event, data)
            this.emit(event, data)
        }
    }

    _processTickerEvent(data, event) {
        try {
            // All values are numbers
            let msg = data[0]
            const update = {
                bid: msg.best_bid,
                ask: msg.best_ask,
                lastPrice: msg.last,
                volume: msg.base_volume_24h,
                high: msg.high_24h,
                low: msg.low_24h
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
                    seq: el.trade_id,
                    price: el.price,
                    amount: el.size,
                    timestamp: el.timestamp,
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
        let channel = `spot/depth:${channelPair}`
        this.unsubscribe(channel);
        this.send({
            op: 'subscribe',
            args: [channel]
        });
        this._channelMap[channel] = {
            channel: 'book',
            pair: pair,
            len: len,
            connect: false,
        }
    }

    unsubscribeOrderBook(pair = 'btc_usdt', len) {
        let channel = len ? `ok_sub_spot_${pair}_depth_${len}` : `ok_sub_spot_${pair}_depth`;

        if (this._channelMap[channel]) {
            this.unsubscribe(channel);
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
        let channel = `spot/trade:${channelPair}`
        this.send({
            op: 'subscribe',
            args: [channel]
        });
        this._channelMap[channel] = {
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
        let channel = `spot/ticker:${channelPair}`
        this.send({
            op: 'subscribe',
            args: [channel]
        });
        this._channelMap[channel] = {
            channel: 'ticker',
            pair: pair,
            connect: false,
        }
    }

    /**
     * Unsubscribe from a channel.
     *
     * @param {number} chanId - ID of the channel received on `subscribed` event
     */
    unsubscribe(chanId) {
        this.send({
            op: 'unsubscribe',
            args: [chanId]
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