'use strict'

const EventEmitter = require('events');
const WebSocket = require('ws');
const debug = require('debug')('gateio:ws2')
const _ = require('lodash');

const WS_URL = 'wss://ws.gate.io/v3/'
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
        this.pongTime;
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
            debug('[gateio ws2 error] received invalid json')
            debug('[gateio ws2 error]  ', msgJSON)
            return
        }

        //debug('Received message:  ', msg)
        this.emit('message', msg, flags);
        //debug('Emmited message event')


        if (msg.result === 'pong') {
            debug('Received pong')
            this.pongTime = new Date().getTime();
            return
        }

        // Drop out early if channel data
        if (msg) {
            return this._handleChannel(msg);
        }

        debug('Emitting \'%s\'  ', msg.event, msg)
        this.emit(msg.event, msg)
    }

    _handleChannel(msg) {
        if (msg.method === 'depth.update') {
            this._processBookEvent(msg.params[1], msg.params[2])
        } else if (msg.method === 'trades') {
            this._processTradeEvent(channelData.data, event)
        } else if (msg.method === 'ticker') {
            this._processTickerEvent(channelData.data, event)
        } else if (msg.method === 'auth') {
            this._processUserEvent(channelData.data)
        } else {
            debug('Message in unknown channel')
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

    _processTickerEvent(msg, event) {
        // All values are numbers
        const update = {
            bid: msg.buy,
            ask: msg.sell,
            lastPrice: msg.last,
            volume: msg.vol,
            high: msg.high,
            low: msg.low
        }

        debug('Emitting ticker, %s,  ', event.pair, update)
        this.emit('ticker', event.pair, update)
    }

    _processTradeEvent(msg, event) {
        if (msg.length == 60) {
            //要最新的交易数据，第一次全量的不要
            return;
        }
        const trades = msg.map(el => {
            return {
                seq: el[0],
                price: el[1],
                amount: el[2],
                timestamp: el[3],
                type: el[4]
            }
        })

        // See http://docs.bitfinex.com/#trades75
        //debug('Emitting trade, %s,  ', event.pair, trades)
        this.emit('trade', event.pair, trades)
    }

    _processBookEvent(msg, event) {
        let update = {};
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
        this.emit('orderbook', event.toLowerCase(), update);
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

    sendCmd(cmd, params) {
        try {
            if (!params) params = [];
            let msg = {
                id: Math.round(new Date().getTime()),
                method: cmd,
                params: params
            }

            this.send(msg);
        } catch (error) {
            debug(error);
        }
    }

    /**
     * Subscribe to order book updates. Snapshot will be sent as multiple updates.
     * Event will be emited as `PAIRNAME_book`.
     *
     * @param {string} pair - btc_usdt, ltc_usdt or ltc_btc .... Default btc_usdt
     * @param {string} length - number of price points. 25 (default) or 100.
     * @see http://docs.bitfinex.com/#order-books
     */
    subscribeOrderBook(pair, len = 30) {
        this.unsubscribeOrderBook();
        pair = _.trim(pair, ",");
        pair = pair.toUpperCase();
        let markets = pair.split(",");
        let params = [];
        if (markets.length > 1) {
            for (let market of markets) {
                if (market && market != "") {
                    params.push([market, len, "0.000001"]);
                }
            }
        } else {
            params = [markets[0], len, "0.000001"];
        }
        this.sendCmd('depth.subscribe', params);
    }

    unsubscribeOrderBook(pair, len) {
        this.sendCmd('depth.unsubscribe');
    }

    /**
     * Subscribe to trades. Snapshot will be sent as multiple updates.
     * Event will be emited as `PAIRNAME_trades`.
     *
     * @param {string} pair - btc_usdt, ltc_usdt or ltc_btc .... Default btc_usdt
     * @see http://docs.bitfinex.com/#trades75
     */
    subscribeTrades(pair = 'btc_usdt') {
        let channel = `ok_sub_spot_${pair}_deals`;
        this.send({
            event: 'addChannel',
            channel: channel,
            pair
        });
        this._channelMap[channel] = {
            channel: 'trades',
            pair: pair,
            connect: false,
        }
    }

    /**
     * @param {string} pair - btc_usdt, ltc_usdt or ltc_btc .... Default btc_usdt
     */
    subscribeTicker(pair = 'btc_usdt') {
        let channel = `ok_sub_spot_${pair}_ticker`;
        this.send({
            event: 'addChannel',
            channel: channel,
            pair
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
            event: 'removeChannel',
            chanId
        })
    }

    sendHeartBeat() {
        if (this.hb) {
            clearInterval(this.hb);
            this.hb = null;
        }
        this.hb = setInterval(() => {
            this.sendCmd('server.ping');
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