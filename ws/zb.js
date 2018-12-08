'use strict'

const EventEmitter = require('events');
const WebSocket = require('ws');
const debug = require('debug')('gateio:ws2')
const _ = require('lodash');
const pako = require('pako');

const WS_URL = 'wss://api.zb.cn:9999/websocket'
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

        //zb websocket数据都是全量，要自己识别出增量数据
        this.orderBookCache = new Map();
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
            debug('[okex ws2 error] received invalid json')
            debug('[okex ws2 error]  ', msgJSON)
            return
        }

        //debug('Received message:  ', msg)
        this.emit('message', msg, flags);
        //debug('Emmited message event')

        // Drop out early if channel data
        if (msg.dataType) {
            return this._handleChannel(msg)
        }

        if (msg.event === 'pong') {
            debug('Received pong')
            this.pongTime = new Date().getTime();
            return
        }

        debug(msg)
        this.emit(msg.event, msg)
    }

    _handleChannel(msg) {
        // First element of Array is the channelId, the rest is the info.
        try {

            const event = this._channelMap[msg.channel]
    
            if (msg[0] === 'hb') {
                return; //debug(`received heartbeat in ${event.channel}`)
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
                debug('Emitting \'%s\'  ', event, ele)
                this.emit(event, ele)
            })
        } else if (data.length) {
            debug('Emitting \'%s\',  ', event, data)
            this.emit(event, data)
        }
    }

    _processTickerEvent(msg, event) {
        try {
            // All values are numbers
            const update = {
                bid: msg.ticker.buy,
                ask: msg.ticker.sell,
                lastPrice: msg.ticker.last,
                volume: msg.ticker.vol,
                high: msg.ticker.high,
                low: msg.ticker.low
            }
    
            this.emit('ticker', event.pair, update)
            
        } catch (error) {
            debug(error);
        }
    }

    _processTradeEvent(msg, event) {
        try {
            for(let item of msg.data){
                const trade = {
                    seq: item.tid,
                    price: item.price,
                    amount: item.amount,
                    timestamp: item.date,
                    type: item.trade_type
                }
        
                //debug('Emitting trade, %s,  ', event.pair, trades)
                this.emit('trade', event.pair, trade)
            }
            
        } catch (error) {
            debug(error);
        }
        
    }

    _processBookEvent(msg, event) {
        try {
            // TODO: Maybe break this up into snapshot/normal handlers? Also trade event
            if(!event.pair){
                debug("no pair.");
                return;
            }
            if(!this.orderBookCache.has(event.pair)){
                this.orderBookCache.set(event.pair, new Map());
            }
    
            let newOrderBook = {};
            if (msg.asks) {
                const asks = msg.asks.map((el) => {
                    return {
                        price: el[0],
                        amount: el[1],
                    }
                })
                newOrderBook.asks = asks;
            }
            if (msg.bids) {
                const bids = msg.bids.map((el) => {
                    return {
                        price: el[0],
                        amount: el[1],
                    }
                })
                newOrderBook.bids = bids;
            }
    
            let changeOrderBook = {asks:[], bids:[]};
            let oldOrderBook = this.orderBookCache.get(event.pair);
            //1. old中存在，new中不存在则删除
            //2. old中存在，new中也存在，则修改
            //3. old中不存在，new中存在，则新增
            this.getChangedOrderBook(oldOrderBook.asks, newOrderBook.asks, changeOrderBook.asks);
            this.getChangedOrderBook(oldOrderBook.bids, newOrderBook.bids, changeOrderBook.bids);
    
            //4. 更新缓存
            this.orderBookCache.set(event.pair, newOrderBook);
            debug(JSON.stringify(newOrderBook));
    
            this.emit('orderbook', event.pair, changeOrderBook);
            
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
        this._channelMap = {};
        this.orderBookCache = new Map();
        //this.sendHeartBeat();
        //this.monitorConnectStatus();
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
        let symbol = pair.replace("_", "");
        let channel = `${symbol}_depth`;
        //this.unsubscribe(channel);
        this.send({
            event: 'addChannel',
            channel: channel
        });
        this._channelMap[channel] = {
            channel: 'book',
            pair: pair,
            len: len,
            connect: false,
        }
    }

    unsubscribeOrderBook(pair = 'btc_usdt', len) {
        let symbol = pair.replace("_", "");
        let channel = `${symbol}_depth`;

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
        let symbol = pair.replace("_", "");
        let channel = `${symbol}_trades`;
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
     * Subscribe to ticker updates. The ticker is a high level overview of the
     * state of the market. It shows you the current best bid and ask, as well as
     * the last trade price.
     *
     * Event will be emited as `PAIRNAME_ticker`.
     *
     * @param {string} pair - btc_usdt, ltc_usdt or ltc_btc .... Default btc_usdt
     */
    subscribeTicker(pair = 'btc_usdt') {
        let symbol = pair.replace("_", "");
        let channel = `${symbol}_ticker`;
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

    getChangedOrderBook(oldOrderBook, newOrderBook, changeOrderBook){
        let existItem = _.intersectionWith(newOrderBook, oldOrderBook, (left, right)=>{return left.price == right.price && left.amount != right.amount;});
        let newItem = _.differenceWith(newOrderBook, oldOrderBook, (left, right)=>{return left.price == right.price;});
        let delItem = _.differenceWith(oldOrderBook, newOrderBook, (left, right)=>{return left.price == right.price;});
        this.updateOrderBook(changeOrderBook, existItem, false);
        this.updateOrderBook(changeOrderBook, newItem, false);
        this.updateOrderBook(changeOrderBook, delItem, true);
    }
    updateOrderBook(books, bookItems, isDel){
        for(let item of bookItems){
            item.count = isDel ? 0 : item.amount;
            books.push(item);
        }
    }
}

module.exports = WSv1;