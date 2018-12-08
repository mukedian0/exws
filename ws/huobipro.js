'use strict'

const EventEmitter = require('events');
const WebSocket = require('ws');
const debug = require('debug')('gateio:ws2')
const _ = require('lodash');
const pako = require('pako');
const WS_URL = 'wss://api.huobi.pro/ws'
const isSnapshot = msg => msg[0] && Array.isArray(msg[0]);
/**
 * Communicates with v1 of the huobi WebSocket API
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
        this.orderBookCache = new Map();
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
        if(msgJSON instanceof String) {
            console.log(msgJSON);
        }else {
            try {
                msg = pako.inflate(msgJSON,{to:'string'});
            } catch (error) {
                debug('[huobi ws2 error] pako.inflate error:',error);
                return false;
            }
        }
        try {
            msg = JSON.parse(msg);
        } catch (e) {
            debug('[huobi ws2 error] received invalid json')
            debug('[huobi ws2 error]  ', msgJSON)
            return false ;
        }
        if(msg.subbed && msg.status == "ok") {
            this._channelMap[msg.subbed].connect = true;
            debug(JSON.stringify(msg));
            return true;
        }
        this.emit('message', msg, flags);

        if(msg.ping) {
            this.pongTime = new Date().getTime();
            this.send({
                pong:msg.ping
            });
            return true;
        } else if(msg.tick) {
            this._handleChannel(msg);
            return true;
        }

        debug('Emitting \'%s\'  ', msg.event, msg)
        this.emit(msg.event, msg)
    }

    _handleChannel(msg) {
        if(!msg) {
            debug('websocket msg is null ');
            return false;
        }
        
        const event = this._channelMap[msg.ch];
        if (event) {
            //debug('Message in \'%s\' channel', event.channel)

            if (event.channel === 'book') {
                this._processBookEvent(msg.tick, event)
            } else if (event.channel === 'trades') {
                this._processTradeEvent(msg.tick, event)
            } else if (event.channel === 'ticker') {
                this._processTickerEvent(msg.tick, event)
            } else if (event.channel === 'auth') {
                this._processUserEvent(msg.tick)
            } else {
                debug('Message in unknown channel')
            }
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
        const trades = msg.data.map(el => {
            return {
                seq: el.id,
                price: el.price,
                amount: el.amount,
                timestamp: el.ts,
                type: el.direction=='buy'?'bid':'ask'
            }
        });
        console.log(JSON.stringify(trades));
        this.emit('trade', event.pair, trades)
    }

    _processBookEvent(msg, event) {
        // TODO: Maybe break this up into snapshot/normal handlers? Also trade event
        try {
            // TODO: Maybe break this up into snapshot/normal handlers? Also trade event
            if(!event.pair){
                debug("no pair.", event);
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
            this._getChangedOrderBook(oldOrderBook.asks, newOrderBook.asks, changeOrderBook.asks);
            this._getChangedOrderBook(oldOrderBook.bids, newOrderBook.bids, changeOrderBook.bids);
    
            //4. 更新缓存
            this.orderBookCache.set(event.pair, newOrderBook);
            debug(JSON.stringify(newOrderBook));
            debug(JSON.stringify(changeOrderBook));
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
        this._channelMap = {}
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
     * @see http://docs.bitfinex.com/#order-books
     */
    subscribeOrderBook(pair = 'btcusdt', len) {
        let channel = len ? `market.${pair}.depth.${len}` : `market.${pair}.depth.step0`;
        if(this._channelMap[channel]) {
            this.unsubscribe(channel,pair);
        }
        this.send({
            'sub':channel,
            'id':`${pair}`
        });
        this._channelMap[channel] = {
            channel: 'book',
            pair: pair,
            len: len,
            connect: false,
        }
    }

    unsubscribeOrderBook(pair = 'btc_usdt', len) {
        
    }

    /**
     * Subscribe to trades. Snapshot will be sent as multiple updates.
     * Event will be emited as `PAIRNAME_trades`.
     *
     * @param {string} pair - btc_usdt, ltc_usdt or ltc_btc .... Default btc_usdt
     */
    subscribeTrades(pair = 'btcusdt') {
        let channel = `market.${pair}.trade.detail`;
        this.send({
            sub: channel,
            id:pair
        });
        this._channelMap[channel] = {
            channel: 'trades',
            pair: pair,
            connect: false,
        }
    }

    /**
     *
     * @param {string} pair - btc_usdt, ltc_usdt or ltc_btc .... Default btc_usdt\
     */
    subscribeTicker(pair = 'btcusdt') {
        
    }

    /**
     * Unsubscribe from a channel.
     *
     * @param {number} chanId - ID of the channel received on `subscribed` event
     */
    unsubscribe(channel,id) {
        this.send({
            'unsub': channel,
            'id':`${id}`
        })
    }

    sendHeartBeat() {
        if (this.hb) {
            clearInterval(this.hb);
            this.hb = null;
        }
        this.hb = setInterval(() => {
            this.send({
                'ping':new Date().getTime()
            })
        }, 5000);
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
    
    _getChangedOrderBook(oldOrderBook, newOrderBook, changeOrderBook){
        let existItem = _.intersectionWith(newOrderBook, oldOrderBook, (left, right)=>{return left.price == right.price && left.amount != right.amount;});
        let newItem = _.differenceWith(newOrderBook, oldOrderBook, (left, right)=>{return left.price == right.price;});
        let delItem = _.differenceWith(oldOrderBook, newOrderBook, (left, right)=>{return left.price == right.price;});
        this._updateOrderBook(changeOrderBook, existItem, false);
        this._updateOrderBook(changeOrderBook, newItem, false);
        this._updateOrderBook(changeOrderBook, delItem, true);
    }
    _updateOrderBook(books, bookItems, isDel){
        for(let item of bookItems){
            item.count = isDel ? 0 : item.amount;
            books.push(item);
        }
    }
}

module.exports = WSv1;